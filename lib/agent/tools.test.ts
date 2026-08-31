import { describe, expect, it } from 'vitest';
import { buildAgentTools } from '@/lib/agent/tools';
import type { AttachedDataFile, DeskContextSnapshot } from '@/lib/agent/desk-context';
import { computeTaskVar } from '@/lib/test-mode/task-var';
import { DEFAULT_VAR_SETUP, type VarSetup } from '@/lib/test-mode/var-setup';
import type { LadderBar } from '@/lib/test-mode/types';
import { makeSimRow } from '@/lib/fx-buffer';

/** Curriculum EUR book: stock 1.9M, flow 1.2M/month (NordTech reference). */
function snapshot(overrides: Partial<DeskContextSnapshot> = {}): DeskContextSnapshot {
  const setup: VarSetup = {
    ...DEFAULT_VAR_SETUP,
    horizon: '1y',
    forecastMonths: 12,
  };
  const bar: LadderBar = {
    ccy: 'EUR',
    stockNetM: 1.9,
    flowM: 1.2,
    avg3mM: 1.9 + 0.5 * 1.2,
    direction: 'long',
  };
  return {
    entityName: 'TestCo',
    dashboardName: 'FX desk',
    risk: [
      {
        bar,
        varStock: computeTaskVar(bar, { ...setup, exposureBasis: 'stock' }),
        varAvg3m: computeTaskVar(bar, { ...setup, exposureBasis: 'avgBuildup' }),
      },
    ],
    varSetup: setup,
    hedgeRatios: {},
    bookedHedges: [],
    preparedByCcy: {},
    marketRatesByCcy: {},
    bookRows: [],
    forecastProfile: null,
    ratesScopeId: 'test-entity',
    ...overrides,
  };
}

/** Invoke a tool's execute directly, bypassing the SDK's streaming call plumbing. */
async function call<R>(
  toolDef: { execute?: (input: never, opts: never) => unknown },
  input: unknown,
): Promise<R> {
  const opts = { toolCallId: 'test', messages: [] };
  return (await toolDef.execute!(input as never, opts as never)) as R;
}

interface VarRowOut {
  ccy: string;
  varBeforeUsdM: number;
  varAfterUsdM: number;
}
interface VarOut {
  rows: VarRowOut[];
  totals: { varBeforeUsdM: number; varAfterUsdM: number; varReductionUsdM: number };
}
interface CfarOut {
  rows: {
    ccy: string;
    method: string;
    grossCfarUsdM: number;
    netCfarUsdM: number;
  }[];
}

describe('agent tools', () => {
  it('get_desk_state reports the EUR exposure and setup', async () => {
    const tools = buildAgentTools(snapshot(), []);
    const state = await call<{
      entity: string;
      currencies: { ccy: string; stockNetLocalM: number; monthlyFlowLocalM: number }[];
      varSetup: { confidencePct: number };
    }>(tools.get_desk_state, {});
    expect(state.entity).toBe('TestCo');
    expect(state.currencies).toHaveLength(1);
    expect(state.currencies[0]).toMatchObject({
      ccy: 'EUR',
      stockNetLocalM: 1.9,
      monthlyFlowLocalM: 1.2,
    });
    expect(state.varSetup.confidencePct).toBe(95);
  });

  it('compute_var returns open VaR and a hedge reduces it', async () => {
    const tools = buildAgentTools(snapshot(), []);
    const open = await call<VarOut>(tools.compute_var, {});
    expect(open.rows).toHaveLength(1);
    expect(open.rows[0]!.varBeforeUsdM).toBeGreaterThan(0);

    const hedged = await call<VarOut>(tools.compute_var, {
      hedgeRatiosPct: { EUR: 100 },
    });
    expect(hedged.rows[0]!.varAfterUsdM).toBeLessThan(
      hedged.rows[0]!.varBeforeUsdM,
    );
    expect(hedged.totals.varReductionUsdM).toBeGreaterThan(0);
  });

  it('compute_var honours setup overrides (99% > 95%)', async () => {
    const tools = buildAgentTools(snapshot(), []);
    const p95 = await call<VarOut>(tools.compute_var, {});
    const p99 = await call<VarOut>(tools.compute_var, {
      setupOverrides: { confidencePct: 99 },
    });
    expect(p99.totals.varBeforeUsdM).toBeGreaterThan(p95.totals.varBeforeUsdM);
  });

  it('compute_var_for_custom_exposure prices off-desk numbers', async () => {
    const tools = buildAgentTools(snapshot(), []);
    const res = await call<{ varUsdM: number }>(
      tools.compute_var_for_custom_exposure,
      { ccy: 'GBP', stockLocalM: 5, monthlyFlowLocalM: 0.5 },
    );
    expect(res.varUsdM).toBeGreaterThan(0);
  });

  it('compute_cfar closed form returns finite reserves', async () => {
    const tools = buildAgentTools(snapshot(), []);
    const res = await call<CfarOut>(tools.compute_cfar, {});
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row.ccy).toBe('EUR');
    expect(row.method).toBe('closedForm');
    expect(Number.isFinite(row.grossCfarUsdM)).toBe(true);
    expect(row.grossCfarUsdM).toBeGreaterThan(0);
  });

  it('compute_cfar Monte Carlo runs with capped paths', async () => {
    const tools = buildAgentTools(snapshot(), []);
    const res = await call<CfarOut>(tools.compute_cfar, {
      ccy: 'EUR',
      method: 'monteCarlo',
    });
    const row = res.rows[0]!;
    expect(row.method).toBe('monteCarlo');
    expect(Number.isFinite(row.grossCfarUsdM)).toBe(true);
  });

  it('analyze_cash_carry runs on the EURUSD seed rates', async () => {
    const tools = buildAgentTools(snapshot(), []);
    const res = await call<{
      horizonMonths: number;
      totals: { netUsdM: number };
    }>(tools.analyze_cash_carry, {});
    expect(Number.isFinite(res.totals.netUsdM)).toBe(true);
    expect(res.horizonMonths).toBe(12);
  });

  it('analyze_liquidity errors when the live book is empty', async () => {
    const tools = buildAgentTools(snapshot(), []);
    const res = await call<{ error: string }>(tools.analyze_liquidity, {});
    expect(res.error).toMatch(/No live FX\/liquidity book/);
  });

  it('analyze_liquidity reports trough and swap on a payout drain', async () => {
    const eur = makeSimRow('eur-1', 'EUR', 2.5, 0, 0, 2.5, -3.0, 0.4, 0);
    const tools = buildAgentTools(snapshot({ bookRows: [eur] }), []);
    const res = await call<{
      timingEnabled: boolean;
      rows: {
        ccy: string;
        openingCashLocalM: number;
        troughCashLocalM: number;
        cycleDrawdownLocalM: number;
        cycles: unknown[];
      }[];
    }>(tools.analyze_liquidity, { ccy: 'EUR' });
    expect(res.timingEnabled).toBe(true);
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row.ccy).toBe('EUR');
    expect(row.openingCashLocalM).toBe(2.5);
    expect(row.troughCashLocalM).toBeLessThan(row.openingCashLocalM);
    expect(row.cycleDrawdownLocalM).toBeGreaterThan(0);
    expect(row.cycles.length).toBeGreaterThan(0);
  });

  it('optimize_liquidity_buffer sizes a larger H* when sigmaP is on', async () => {
    const eur = makeSimRow('eur-1', 'EUR', 2.5, 0, 0, 2.5, -3.0, 0.4, 0);
    const tools = buildAgentTools(snapshot({ bookRows: [eur] }), []);
    const plain = await call<{
      rows: { layeredHStarLocalM: number; swapNeededLocalM: number }[];
    }>(tools.optimize_liquidity_buffer, {});
    const buffered = await call<{
      rows: { layeredHStarLocalM: number; swapNeededLocalM: number }[];
    }>(tools.optimize_liquidity_buffer, {
      layers: ['sigmaP'],
      sigmaP: 0.2,
    });
    expect(buffered.rows[0]!.layeredHStarLocalM).toBeGreaterThan(
      plain.rows[0]!.layeredHStarLocalM,
    );
  });

  it('read_uploaded_data returns attached tables and a graceful error otherwise', async () => {
    const file: AttachedDataFile = {
      name: 'exposures.csv',
      kind: 'csv',
      headers: ['ccy', 'exposure_m'],
      rows: [
        ['EUR', 1.9],
        ['GBP', 0.4],
      ],
      totalRows: 2,
    };
    const withFile = buildAgentTools(snapshot(), [file]);
    const res = await call<{ files: { rows: unknown[] }[] }>(
      withFile.read_uploaded_data,
      {},
    );
    expect(res.files[0]!.rows).toHaveLength(2);

    const withoutFile = buildAgentTools(snapshot(), []);
    const err = await call<{ error: string }>(withoutFile.read_uploaded_data, {});
    expect(err.error).toMatch(/No files attached/);
  });
});
