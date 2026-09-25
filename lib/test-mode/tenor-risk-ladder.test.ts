import { describe, expect, it } from 'vitest';
import { makeSimRow } from '@/lib/fx-buffer';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import { buildTenorRiskLadder } from '@/lib/test-mode/tenor-risk-ladder';

const SETUP = {
  ...DEFAULT_VAR_SETUP,
  forecastMonths: 12,
  confidencePct: 95 as const,
  exposureBasis: 'totalBuildup' as const,
};

const EUR = makeSimRow('1', 'EUR', 2.5, 0, 0, 2.5, 0, 1.2, 0);

function ladder(over?: Partial<Parameters<typeof buildTenorRiskLadder>[0]>) {
  return buildTenorRiskLadder({
    ccy: 'EUR',
    row: EUR,
    stockM: 2.5,
    monthlyFlowM: 1.2,
    monthlyFlows: Array.from({ length: 12 }, () => 1.2),
    setup: SETUP,
    bookedHedges: [],
    hedgeNotionalLocalM: 0,
    ...over,
  });
}

describe('buildTenorRiskLadder', () => {
  it('leads with Cash then every VaR tenor; P&L = cash carry + M2M', () => {
    const rows = ladder();
    expect(rows.map(r => r.id)).toEqual([
      'cash',
      '1w',
      '1m',
      '3m',
      '6m',
      '9m',
      '1y',
    ]);
    const cash = rows[0]!;
    expect(cash.label).toBe('Cash');
    expect(cash.months).toBe(0);
    expect(cash.m2mUsdM).toBe(0);
    expect(cash.cashCarryUsdM).toBe(0);
    for (const r of rows) {
      expect(r.totalPnlUsdM).toBeCloseTo(r.cashCarryUsdM + r.m2mUsdM, 8);
      expect(Number.isFinite(r.gammaUsdPerPctSq)).toBe(true);
    }
    // CIP + cash-carry marks are linear in USD/FCY for EUR — convexity ~0.
    expect(rows.find(r => r.id === 'cash')!.gammaUsdPerPctSq).toBeCloseTo(0, 8);
  });

  it('wires Cash residual to the unmatched book at t=0 with overnight VaR/CFaR', () => {
    const rows = ladder();
    const cash = rows.find(r => r.id === 'cash')!;
    expect(cash.residualLocalM).toBeCloseTo(2.5, 8);
    expect(cash.residualVarUsdM).toBeGreaterThan(0);
    expect(cash.residualCfarUsdM).toBeGreaterThan(0);
    expect(Math.abs(cash.deltaUsdPerPct)).toBeGreaterThan(0.01);
  });

  it('grows residual VaR with tenor on an unhedged book', () => {
    const rows = ladder();
    const m1 = rows.find(r => r.id === '1m')!;
    const m3 = rows.find(r => r.id === '3m')!;
    expect(m3.residualVarUsdM).toBeGreaterThan(m1.residualVarUsdM);
    expect(m1.residualVarUsdM).toBeGreaterThan(0);
  });

  it('signs delta with residual FX and keeps vega non-negative', () => {
    const rows = ladder();
    for (const r of rows) {
      expect(Math.sign(r.deltaUsdPerPct) || 0).toBe(Math.sign(r.residualLocalM) || 0);
      expect(r.vegaUsdPerVolPt).toBeGreaterThanOrEqual(0);
    }
    const m1 = rows.find(r => r.id === '1m')!;
    // +1% on ~€2.5M+flow at curriculum EUR spot 1.0 is tens of $K.
    expect(Math.abs(m1.deltaUsdPerPct)).toBeGreaterThan(0.01);
  });

  it('cuts residual VaR at 1y after a full-cover forward', () => {
    const ticket: HedgeTicket = {
      id: 'eur-fwd',
      ccy: 'EUR',
      instrument: 'forward',
      basis: 'totalBuildup',
      amountLocalM: 2.5 + 1.2 * 12,
      maturity: '1y',
      maturityLabel: '1 year',
      varUsdM: 0.1,
      addressesHigherVar: false,
      status: 'booked',
    };
    const open = ladder();
    const hedged = ladder({
      bookedHedges: [ticket],
      hedgeNotionalLocalM: ticket.amountLocalM,
    });
    const openY = open.find(r => r.id === '1y')!;
    const hedgedY = hedged.find(r => r.id === '1y')!;
    expect(Math.abs(hedgedY.residualLocalM)).toBeLessThan(Math.abs(openY.residualLocalM));
    expect(hedgedY.residualVarUsdM).toBeLessThan(openY.residualVarUsdM);
  });

  it('attributes IR-book DV01 to the Cash tenor only', () => {
    const withDur = {
      ...EUR,
      ir_asset_notional: 10,
      ir_liab_notional: 0,
      ir_net_dur: 5,
    };
    const plain = ladder();
    const ir = ladder({ row: withDur });
    const cash = (rows: ReturnType<typeof ladder>) => rows.find(r => r.id === 'cash')!;
    const y = (rows: ReturnType<typeof ladder>) => rows.find(r => r.id === '1y')!;
    expect(Math.abs(cash(ir).dv01Usd)).toBeGreaterThan(Math.abs(cash(plain).dv01Usd));
    // Forward tenors keep residual FX IR01 only — IR book does not leak onto 1y.
    expect(y(ir).dv01Usd).toBeCloseTo(y(plain).dv01Usd, 8);
  });

  it('fills Gamma (convexity) and keeps EUR CIP gamma near zero', () => {
    const rows = ladder();
    for (const r of rows) {
      expect(Number.isFinite(r.gammaUsdPerPctSq)).toBe(true);
    }
    const cash = rows.find(r => r.id === 'cash')!;
    const m1 = rows.find(r => r.id === '1m')!;
    expect(cash.gammaUsdPerPctSq).toBeCloseTo(0, 8);
    // Linear CIP + scaled carry → convexity is a rounding residual.
    expect(Math.abs(m1.gammaUsdPerPctSq)).toBeLessThan(1e-6);
  });
});
