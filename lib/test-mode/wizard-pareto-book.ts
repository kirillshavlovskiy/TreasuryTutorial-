/**
 * Price Pareto Optimize cards from the live Σ⁻¹μ overlay book.
 * Layout lives in LiquidityWizardPanels; this only builds the numbers.
 */

import {
  CURRENCY_PARAMS,
  POLICY_VAR_LIMITS,
  type RowState,
} from '@/lib/fx-buffer';
import { impliedPortfolioRFcyPct } from '@/lib/dashboard-model';
import {
  buildEfficientCarryVarFrontier,
  l1Weights,
} from '@/lib/portfolio-alloc';
import {
  generateUsableParetoScenarios,
  overlaySampleVars,
  type GeneratedParetoPick,
  type PortfolioScenarioId,
} from '@/lib/test-mode/portfolio-carry-scenarios';
import {
  priceOverlayFillCashSwapUsdYr,
  type PortfolioFrontierEngine,
} from '@/lib/test-mode/portfolio-liquidity-frontier';
import type { LiquidityStrategyResult } from '@/lib/test-mode/liquidity-strategies';
import type { PortfolioCarryFrontier } from '@/lib/fx-buffer';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import type { FrontierSolutionCard } from '@/components/test-mode/LiquidityWizardPanels';

export function buildWizardParetoUniverse(input: {
  selected: LiquidityStrategyResult;
  bookRows: readonly RowState[];
  includeCcy: (ccy: string) => boolean;
  frontierEngine: PortfolioFrontierEngine;
  universeFrontier: PortfolioCarryFrontier | null;
  policyUsdM: number;
  portfolioCarryK?: number;
  confidencePct: number;
  r_USD: number;
  forecastMonths: number;
  bookingMode: 'rolling' | 'term' | 'stripTerm';
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  activeLayers?: ReadonlySet<string>;
  cfarNetByCcyUsd?: Record<string, number>;
  liveOverlayFcyByCcy?: Readonly<Record<string, number>>;
}): {
  cards: FrontierSolutionCard[];
  bookFront: { x: number; y: number }[];
} {
  const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
  const rows = input.bookRows.filter(
    r => r.ccy !== 'USD' && CURRENCY_PARAMS[r.ccy] && input.includeCcy(r.ccy),
  );
  const mixOf = (legs: { ccy: string; usdM: number }[]) => {
    const weights = l1Weights(legs.map(l => l.usdM));
    return legs
      .map((l, i) => ({ ccy: l.ccy, w: weights[i]! }))
      .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
      .slice(0, 3)
      .map(l => `${l.ccy} ${(l.w * 100).toFixed(0)}%`)
      .join(' · ');
  };

  const allocInput = (varCapUsdM: number, carryTargetUsdYrM?: number) => {
    if (rows.length < 1) return null;
    const tenorMonths = input.bookingMode === 'rolling'
      ? 1
      : Math.max(1, input.forecastMonths);
    return buildEfficientCarryVarFrontier({
      ccys: rows.map(r => r.ccy),
      mu: rows.map(r => (
        impliedPortfolioRFcyPct(
          r.ccy, r.r_FCY, input.r_USD, input.marketRatesByCcy, tenorMonths,
        ) - input.r_USD
      ) / 100),
      varCapUsdM,
      carryTargetUsdYrM,
      basesFcy: rows.map(r => Math.max(r.cash + r.payout, 0)),
      rOd: rows.map(r => r.r_OD),
      r_USD: input.r_USD,
      fixedCfarUsdM: input.activeLayers?.has('cfarCover')
        ? rows.map(r => Math.abs(input.cfarNetByCcyUsd?.[r.ccy] ?? 0))
        : undefined,
    });
  };

  const priceOverlay = (
    overlayFcyByCcy: Record<string, number>,
    overlayVarUsdM: number,
    mix: string,
  ) => {
    const bookCarryUsdYrM = priceOverlayFillCashSwapUsdYr({
      result: input.selected,
      rows,
      engine: input.frontierEngine,
      overlayFcyByCcy,
      liveOverlayFcyByCcy: input.liveOverlayFcyByCcy,
    });
    return { overlayVarUsdM, bookCarryUsdYrM, mix };
  };

  const priceAtVar = (varCapUsdM: number) => {
    const alloc = allocInput(varCapUsdM);
    if (!alloc) return null;
    const overlayFcyByCcy = Object.fromEntries(alloc.capLegs.map(l => [l.ccy, l.fcyM]));
    return priceOverlay(overlayFcyByCcy, alloc.cap.varUsdM, mixOf(alloc.capLegs));
  };

  const samples = overlaySampleVars(input.universeFrontier, input.policyUsdM)
    .map(v => priceAtVar(v))
    .filter((row): row is NonNullable<ReturnType<typeof priceAtVar>> => row != null);

  const askK = input.portfolioCarryK;
  if (askK != null && Number.isFinite(askK) && askK > 0) {
    const hit = allocInput(maxTier, askK / 1000);
    if (hit) {
      const overlayFcyByCcy = Object.fromEntries(hit.legs.map(l => [l.ccy, l.fcyM]));
      const priced = priceOverlay(overlayFcyByCcy, hit.sweet.varUsdM, mixOf(hit.legs));
      if (priced) samples.push(priced);
    }
  }

  const picks = generateUsableParetoScenarios({
    samples,
    budgetUsdM: input.policyUsdM,
    carryTargetUsdYrM: askK != null && Number.isFinite(askK) ? askK / 1000 : undefined,
    confidencePct: input.confidencePct,
  });

  const toCard = (p: GeneratedParetoPick): FrontierSolutionCard => ({
    id: p.id,
    name: p.label,
    short: p.disabled
      ? (p.disabledHint ?? 'not on this front')
      : `${p.mix || p.short} · Pareto book`,
    rationale: p.rationale,
    carryUsdYrM: p.bookCarryUsdYrM,
    riskUsdM: p.overlayVarUsdM,
    usedPct: maxTier > 0 ? (p.overlayVarUsdM / maxTier) * 100 : 0,
    efficiency: p.overlayVarUsdM > 1e-9 ? (p.bookCarryUsdYrM * 1000) / p.overlayVarUsdM : 0,
    approved: !p.disabled && p.overlayVarUsdM <= input.policyUsdM + 0.05,
    disabled: p.disabled,
  });

  const bookFront = [...samples]
    .sort((a, b) => a.overlayVarUsdM - b.overlayVarUsdM)
    .map(s => ({ x: s.overlayVarUsdM, y: s.bookCarryUsdYrM }));

  return { cards: picks.map(toCard), bookFront };
}

export type { PortfolioScenarioId };
