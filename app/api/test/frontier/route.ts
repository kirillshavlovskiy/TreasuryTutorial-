import { NextRequest, NextResponse } from 'next/server';
import { type RowState } from '@/lib/fx-buffer';
import {
  buildPortfolioLiquidityFrontier,
  toPortfolioCarryFrontier,
  type PortfolioFrontierEngine,
} from '@/lib/test-mode/portfolio-liquidity-frontier';
import { orderedLiquidityScenarioPoints } from '@/lib/test-mode/portfolio-modal-align';
import { deskCarryTargetUsdYr, pointForScenario } from '@/lib/test-mode/solution-pick';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      result,
      strategy,
      rows,
      engine,
      portfolioCarryK,
      policyCapUsd,
    } = body as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pre-existing, unrelated to this session's changes
      result: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pre-existing, unrelated to this session's changes
      strategy: any;
      rows: RowState[];
      engine: PortfolioFrontierEngine;
      portfolioCarryK?: number | null;
      policyCapUsd?: number | null;
    };

    console.log('=== FRONTIER CALCULATION REQUEST ===');
    console.log('portfolioCarryK:', portfolioCarryK);
    console.log('policyCapUsd:', policyCapUsd);

    // Step 1: Build portfolio liquidity frontier
    console.log('\n[Step 1] Building portfolio liquidity frontier...');
    const liqFrontier = buildPortfolioLiquidityFrontier({
      result,
      strategy,
      rows,
      engine,
    });
    console.log('Liquidity frontier built. Point count:', liqFrontier.open.length);
    console.log('First point carry:', liqFrontier.open[0]?.carryUsdYrM);
    console.log('Last point carry:', liqFrontier.open[liqFrontier.open.length - 1]?.carryUsdYrM);

    // Step 2: Convert to PortfolioCarryFrontier
    console.log('\n[Step 2] Converting to PortfolioCarryFrontier with carryTargetUsdYrM...');
    const carryTargetUsdYrM = portfolioCarryK != null && Number.isFinite(portfolioCarryK)
      ? portfolioCarryK / 1000
      : undefined;
    console.log('carryTargetUsdYrM computed:', carryTargetUsdYrM);

    const built = toPortfolioCarryFrontier(liqFrontier);
    const frontier = { ...built, carryTargetUsdYrM };
    console.log('Frontier converted. Point count:', frontier.points.length);
    console.log('Frontier.carryTargetUsdYrM stored:', frontier.carryTargetUsdYrM);
    console.log('First frontier point carry:', frontier.points[0]?.totalCarryUsdYr);
    console.log('Last frontier point carry:', frontier.points[frontier.points.length - 1]?.totalCarryUsdYr);

    // Step 3: Find ordered scenario points
    console.log('\n[Step 3] Finding ordered liquidity scenario points...');
    const ask = carryTargetUsdYrM ?? 0.032; // DEFAULT_DESK_TARGET_CARRY_USD_YR
    console.log('ask (target carry in millions):', ask);
    console.log('ask * 1000 (in thousands):', ask * 1000);

    const ordered = orderedLiquidityScenarioPoints({
      points: frontier.points,
      policyCapUsd: policyCapUsd ?? 5,
      carryTargetUsdYr: ask,
    });

    console.log('\n[Step 3 Result] Ordered points:');
    console.log('  origin carry:', ordered.origin?.totalCarryUsdYr, '(in K:', ordered.origin ? ordered.origin.totalCarryUsdYr * 1000 : 'N/A', ')');
    console.log('  carryTarget carry:', ordered.carryTarget?.totalCarryUsdYr, '(in K:', ordered.carryTarget ? ordered.carryTarget.totalCarryUsdYr * 1000 : 'N/A', ')');
    console.log('  conservative carry:', ordered.conservative?.totalCarryUsdYr);
    console.log('  balanced carry:', ordered.balanced?.totalCarryUsdYr);
    console.log('  maxCarry carry:', ordered.maxCarry?.totalCarryUsdYr);

    // Step 4: Get carry target point using pointForScenario
    console.log('\n[Step 4] Computing carryTargetPoint via pointForScenario...');
    const carryTargetPoint = pointForScenario({
      frontier,
      scenarioId: 'carryTarget',
      policyCapUsd: policyCapUsd ?? 5,
      carryTargetUsdYr: ask,
      confidencePct: 95,
    });

    console.log('[Step 4 Result] carryTargetPoint:');
    console.log('  carry:', carryTargetPoint?.totalCarryUsdYr, '(in K:', carryTargetPoint ? carryTargetPoint.totalCarryUsdYr * 1000 : 'N/A', ')');
    console.log('  var:', carryTargetPoint?.portfolioVarUsd);
    console.log('  k:', carryTargetPoint?.k);

    console.log('\n=== FRONTIER CALCULATION COMPLETE ===\n');

    return NextResponse.json({
      success: true,
      frontier: {
        points: frontier.points.map(p => ({
          k: p.k,
          portfolioVarUsd: p.portfolioVarUsd,
          totalCarryUsdYr: p.totalCarryUsdYr,
        })),
        carryTargetUsdYrM: frontier.carryTargetUsdYrM,
      },
      ordered: {
        origin: ordered.origin ? {
          k: ordered.origin.k,
          portfolioVarUsd: ordered.origin.portfolioVarUsd,
          totalCarryUsdYr: ordered.origin.totalCarryUsdYr,
        } : null,
        carryTarget: ordered.carryTarget ? {
          k: ordered.carryTarget.k,
          portfolioVarUsd: ordered.carryTarget.portfolioVarUsd,
          totalCarryUsdYr: ordered.carryTarget.totalCarryUsdYr,
        } : null,
        conservative: ordered.conservative ? {
          k: ordered.conservative.k,
          portfolioVarUsd: ordered.conservative.portfolioVarUsd,
          totalCarryUsdYr: ordered.conservative.totalCarryUsdYr,
        } : null,
      },
      carryTargetPoint: carryTargetPoint ? {
        k: carryTargetPoint.k,
        portfolioVarUsd: carryTargetPoint.portfolioVarUsd,
        totalCarryUsdYr: carryTargetPoint.totalCarryUsdYr,
      } : null,
      debug: {
        portfolioCarryK,
        carryTargetUsdYrM,
        ask,
      },
    });
  } catch (error) {
    console.error('=== FRONTIER CALCULATION ERROR ===');
    console.error(error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
