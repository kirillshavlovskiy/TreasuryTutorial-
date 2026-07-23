import { describe, it, expect } from 'vitest';
import { INITIAL_ROWS, INITIAL_USD_PARAMS, isPayCarry } from './fx-buffer';
import { computeDashboardModel } from './dashboard-model';

describe('PAY carry zero-payout targets', () => {
  it('allowsNegativeNp PAY rows have negative H* pre (no +σ on stock)', () => {
    const shared = { r_USD: 3.50, σ_P: 0.10, days: 3 };
    // Loose VAR budget + ample USD so the carry overlay is active (not VAR-trimmed):
    // PAY cheap-OD rows are sold below zero to earn the USD carry.
    const model = computeDashboardModel({
      rows: INITIAL_ROWS,
      usdCash: 900,
      usdNonNpCash: 154.1,
      usdParams: INITIAL_USD_PARAMS,
      shared,
      activeLayers: new Set(['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv'] as const),
      policyVAR: 20.0,
    });
    const bad: string[] = [];
    for (const r of model.fcyComputed) {
      if (!isPayCarry(shared.r_USD, r.r_FCY)) continue;
      if (r.payout !== 0) continue;
      const p = model.layerRows.find(l => l.ccy === r.ccy)!;
      if (p.r_OD <= shared.r_USD && r.cash_threshold_pre_swap >= -0.001) {
        bad.push(`${r.ccy}: hPre=${r.cash_threshold_pre_swap.toFixed(2)} r_OD=${p.r_OD}`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
