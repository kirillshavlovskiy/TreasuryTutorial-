const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skuiPath = path.join(
  process.env.APPDATA,
  'Cursor/User/History/3bee36d5/skui.tsx',
);
const plfPath = path.join(root, 'lib/test-mode/portfolio-liquidity-frontier.ts');
const panelsPath = path.join(root, 'components/test-mode/LiquidityWizardPanels.tsx');

const skui = fs.readFileSync(skuiPath, 'utf8');
const lines = skui.split(/\n/);
const slice = (a, b) => lines.slice(a - 1, b).join('\n');

// 1) Overlay pricing helpers
let plf = fs.readFileSync(plfPath, 'utf8');
if (!plf.includes('priceOverlayFillCashSwapByCcy')) {
  plf += `

export type OverlayFillPriceInput = {
  result: LiquidityStrategyResult;
  rows: readonly RowState[];
  engine: PortfolioFrontierEngine;
  overlayFcyByCcy: Readonly<Record<string, number>>;
  /** When the live plan already embeds today's overlay, subtract it before adding the scenario fill. */
  liveOverlayFcyByCcy?: Readonly<Record<string, number>>;
};

/**
 * Per-name cash Δr of the live strip plus a named overlay fill
 * (hold + overlay FCY). Sum is the desk number on a scenario card —
 * not Σ⁻¹μ × k on a straight ray.
 */
export function priceOverlayFillCashSwapByCcy(
  input: OverlayFillPriceInput,
): { ccy: string; usdM: number }[] {
  const rowByCcy = new Map(input.rows.map(r => [r.ccy, r] as const));
  const rows: { ccy: string; usdM: number }[] = [];
  for (const c of input.result.byCcy) {
    const row = rowByCcy.get(c.ccy);
    if (!row) continue;
    const live = signedPeakStanding(c.plan);
    const liveOv = input.liveOverlayFcyByCcy?.[c.ccy] ?? 0;
    const fill = live - liveOv + (input.overlayFcyByCcy[c.ccy] ?? 0);
    const bookCashK = bookCashCarryK(
      live,
      ccySpotRate(row.ccy),
      row.r_FCY,
      input.engine.shared.r_USD,
      row.r_OD,
    );
    const priced = priceLiquidityStanding(
      { ...input.engine, row },
      fill,
      bookCashK,
    );
    rows.push({ ccy: c.ccy, usdM: priced.open.cashCarryUsdYrM });
  }
  return rows;
}

export function priceOverlayFillCashSwapUsdYr(input: OverlayFillPriceInput): number {
  return priceOverlayFillCashSwapByCcy(input).reduce((s, r) => s + r.usdM, 0);
}
`;
  fs.writeFileSync(plfPath, plf);
  console.log('appended overlay pricing helpers');
} else {
  console.log('overlay helpers already present');
}

// 2) Build LiquidityWizardPanels.tsx from skui snippets
const body = [
  slice(93, 163), // FrontierSolutionCard + overlay helpers
  slice(1354, 1592), // SignedCarryMeter .. DetailMetrics
  slice(1781, 2478), // VAR_POLICY .. ContributionBar end
].join('\n\n');

const header = `'use client';

/**
 * Wizard Scenarios / Optimize panels restored from the local Liquidity wizard.
 * Shared calc stays in LiquidityAnalyticsView (handover overlay / frontier).
 */

import { useRef, useState, type PointerEvent } from 'react';
import {
  cfarTailProbability,
  probabilityWeightedReturnUsdM,
  type LiquidityStrategyCcy,
  type LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';
import {
  computePortfolioVAR,
  CURRENCY_PARAMS,
} from '@/lib/fx-buffer';
import {
  type EfficientCarryLeg,
} from '@/lib/portfolio-alloc';
import {
  diversifiedUsdRisk,
  signedCfarUsdM,
  type PortfolioLiquidityFrontier,
} from '@/lib/test-mode/portfolio-liquidity-frontier';
import {
  signedPeakStanding as frontierBookStanding,
} from '@/lib/test-mode/liquidity-frontier';
import type { PortfolioScenarioId } from '@/lib/test-mode/portfolio-carry-scenarios';

`;

// Rewrite local helpers that were file-scoped in skui to exports
let panels = header + body;
panels = panels
  .replace(/^type FrontierSolutionCard/m, 'export type FrontierSolutionCard')
  .replace(/^type OverlayContrib/m, 'export type OverlayContrib')
  .replace(/^function overlayVarRows/m, 'export function overlayVarRows')
  .replace(/^function strategyTotalCarryUsdYrM/m, 'export function strategyTotalCarryUsdYrM')
  .replace(/^function weightedReturnUsdYrM/m, 'export function weightedReturnUsdYrM')
  .replace(/^function SignedCarryMeter/m, 'export function SignedCarryMeter')
  .replace(/^function ParetoScenarioCard/m, 'export function ParetoScenarioCard')
  .replace(/^function SolutionCard/m, 'export function SolutionCard')
  .replace(/^function Metric/m, 'function Metric')
  .replace(/^function DetailMetrics/m, 'export function DetailMetrics')
  .replace(/^function VarBudgetUsage/m, 'export function VarBudgetUsage')
  .replace(/^function fmtK\(usdM: number\): string \{[\s\S]*?\n\}/m, '') // use shared below
  .replace(/^function fmtM\(m: number\): string \{[\s\S]*?\n\}/m, '')
  .replace(/^function resolveBookRow[\s\S]*?\n\}/m, '');

// Add fmt helpers used by panels
panels = panels.replace(
  "import type { PortfolioScenarioId } from '@/lib/test-mode/portfolio-carry-scenarios';\n",
  `import type { PortfolioScenarioId } from '@/lib/test-mode/portfolio-carry-scenarios';

function fmtK(usdM: number): string {
  const k = usdM * 1000;
  if (Math.abs(k) < 0.5) return '$0K';
  return \`\${k >= 0 ? '' : '−'}$\${Math.abs(k).toFixed(0)}K\`;
}
`,
);

fs.writeFileSync(panelsPath, panels);
console.log('wrote', panelsPath, 'bytes', panels.length);
