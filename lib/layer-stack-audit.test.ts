/**
 * Layer-by-layer stacking audit — documents Target LP Cash as layers are added.
 */
import { describe, it, expect } from 'vitest';
import {
  INITIAL_ROWS, INITIAL_USD_PARAMS, Z_NEUTRAL, netPayoutDeficit,
  computePortfolioVAR, type LayerId,
} from './fx-buffer';
import { computeDashboardModel } from './dashboard-model';

const SHARED = { r_USD: 3.50, σ_P: 0.10, days: 3 };
const POLICY_VAR = 5.0;

function layers(...ids: LayerId[]): Set<LayerId> {
  return new Set(ids);
}

function modelFor(ccy: string, payout: number, active: Set<LayerId>, policyVAR = POLICY_VAR) {
  return computeDashboardModel({
    rows: INITIAL_ROWS.map(r => r.ccy === ccy ? { ...r, payout } : r),
    usdCash: 303.9,
    usdNonLpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: SHARED,
    activeLayers: active,
    policyVAR,
  });
}

function rowSnapshot(m: ReturnType<typeof computeDashboardModel>, ccy: string) {
  const fc = m.fcyComputed.find(r => r.ccy === ccy)!;
  const lr = m.layerRows.find(r => r.ccy === ccy)!;
  return {
    opening: fc.cash,
    payout: fc.payout,
    trough: fc.lp_peak_cash,
    deficit: netPayoutDeficit(fc.payout, fc.cash),
    floor: lr.floor_contrib,
    sigma: lr.delta_sigma,
    carry: lr.delta_carry,
    portfolio: lr.delta_portfolio,
    hPre: fc.cash_threshold_pre_swap,
    target: fc.cash_threshold,
    lpSwap: fc.postSwapCash,
    swap: fc.swapNear,
    varBinding: lr.var_binding,
    budgetBinding: lr.budget_binding,
  };
}

describe('layer-by-layer stacking audit', () => {
  it('CAD PAY −100M: incremental layers (documents numbers)', () => {
    const steps = [
      { name: 'none', active: layers() },
      { name: 'floor', active: layers('floorH') },
      { name: '+sigma', active: layers('floorH', 'sigmaP') },
      { name: '+carry', active: layers('floorH', 'sigmaP', 'carryOptim') },
      { name: '+portfolio', active: layers('floorH', 'sigmaP', 'carryOptim', 'portfolioDiv') },
    ];
    const table: Record<string, ReturnType<typeof rowSnapshot>> = {};
    for (const s of steps) {
      table[s.name] = rowSnapshot(modelFor('CAD', -100, s.active), 'CAD');
    }

    // No formula layers → no liquidity rule to satisfy, so the swap stays
    // silent and the book is held: Target = LP+Swap = opening cash, and the
    // trough stays overdrawn as a structural gap for carry to price.
    expect(table.none!.swap).toBe(0);
    expect(table.none!.target).toBeCloseTo(table.none!.opening, 1);
    expect(table.none!.lpSwap).toBeCloseTo(table.none!.opening, 1);
    expect(table.none!.trough).toBeCloseTo(-4.9, 1);

    // Sigma on gross |payout|: cushion H* = σ (survives the payout);
    // Target = LP+Swap = |payout| + σ (funds the payout plus the cushion)
    const expectedSigma = 100 * SHARED.σ_P * Z_NEUTRAL;
    expect(table['+sigma']!.sigma).toBeCloseTo(expectedSigma, 2);
    expect(table['+sigma']!.hPre).toBeCloseTo(expectedSigma, 1);
    expect(table['+sigma']!.target).toBeCloseTo(100 + expectedSigma, 1);
    expect(table['+sigma']!.lpSwap).toBeCloseTo(100 + expectedSigma, 1);

    // Carry subtracts for PAY (negative delta_carry)
    expect(table['+carry']!.carry).toBeLessThan(0);
    expect(table['+carry']!.hPre).toBeLessThan(table['+sigma']!.hPre);

    // Portfolio without carry must not inject carry-like δ
    const portOnly = rowSnapshot(
      modelFor('CAD', -100, layers('floorH', 'sigmaP', 'portfolioDiv')),
      'CAD',
    );
    expect(portOnly.carry).toBeCloseTo(0, 1);
    expect(portOnly.portfolio).toBeCloseTo(0, 1);
    expect(portOnly.target).toBeCloseTo(table['+sigma']!.target, 1);

    console.table(Object.entries(table).map(([step, r]) => ({
      step,
      trough: r.trough.toFixed(2),
      sigma: r.sigma.toFixed(3),
      carry: r.carry.toFixed(2),
      portfolio: r.portfolio.toFixed(2),
      hPre: r.hPre.toFixed(2),
      target: r.target.toFixed(2),
    })));
  });

  it('HUF EARN zero payout: carry adds on opening stock', () => {
    const base = rowSnapshot(modelFor('HUF', 0, layers('floorH', 'sigmaP')), 'HUF');
    const withCarry = rowSnapshot(
      modelFor('HUF', 0, layers('floorH', 'sigmaP', 'carryOptim')),
      'HUF',
    );
    expect(withCarry.carry).toBeGreaterThan(0);
    expect(withCarry.hPre).toBeGreaterThan(base.hPre);
  });

  it('portfolio limiter: policyVAR drives optimizePortfolioCarry constraint', () => {
    const m = modelFor('CAD', -100, layers('floorH', 'sigmaP', 'carryOptim', 'portfolioDiv'), 10);
    expect(m.portfolioSummary!.policyVAR).toBe(10);
    expect(m.portfolioSummary!.portfolio_VAR_USD).toBeGreaterThan(0);
    // Limiter lives in optimizePortfolioCarry → findVarLambda bisects λ_var until Portfolio_VAR ≤ policyVAR
  });

  it('dashboard exposes portfolio summary when portfolioDiv active', () => {
    const m = modelFor('CAD', -100, layers('floorH', 'sigmaP', 'carryOptim', 'portfolioDiv'));
    expect(m.portfolioSummary).not.toBeNull();
    expect(m.portfolioSummary!.policyVAR).toBe(POLICY_VAR);
    // Summary VAR = OVERLAY VAR (deviation from hold-the-book base), matching
    // the optimizer and the cap — not the VAR of total holdings.
    const portVar = computePortfolioVAR(
      m.layerRows.filter(r => r.ccy !== 'USD').map(r => ({
        ccy: r.ccy,
        cashFCY: r.usd_stress_trim ? 0 : r.cash_threshold - (r.base_hold ?? r.cash_threshold),
      })),
    );
    expect(m.portfolioSummary!.portfolio_VAR_USD).toBeCloseTo(portVar.portfolio_VAR_USD, 4);
    // Overlay fills the budget (≤ policy limit)
    expect(m.portfolioSummary!.portfolio_VAR_USD).toBeLessThanOrEqual(POLICY_VAR + 1e-6);
  });
});
