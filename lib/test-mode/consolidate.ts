import { makeSimRow, INITIAL_USD_PARAMS, type RowState, type UsdParams } from '@/lib/fx-buffer';
import { computeStockLadder } from '@/lib/test-mode/exposure-ladder';
import { classifyNordtechEntity, simSeedForEntity } from '@/lib/test-mode/nordtech-sim-seed';
import { computeTaskVar, type VarResult } from '@/lib/test-mode/task-var';
import type { LadderBar } from '@/lib/test-mode/types';
import type { VarConfidencePct } from '@/lib/test-mode/var-confidence';
import {
  DEFAULT_VAR_SETUP,
  type VarSetup,
} from '@/lib/test-mode/var-setup';
import type { Entity } from '@/lib/workspace-store';

export interface ConsolidatedBook {
  rows: RowState[];
  usdCash: number;
  usdNonLpCash: number;
  usdParams: UsdParams;
  /** Entity contribution labels for tooltips. */
  sourcesByCcy: Record<string, string[]>;
}

export interface CurrencyRiskRow {
  bar: LadderBar;
  varStock: VarResult;
  varAvg3m: VarResult;
}

/** Sum numeric fields across rows that share a currency. */
function mergeRows(rows: RowState[]): RowState {
  const base = rows[0]!;
  const out = makeSimRow(
    `consol-${base.ccy}`,
    base.ccy,
    0, 0, 0, 0, 0, 0, 0,
  );
  out.σ_daily = base.σ_daily;
  out.r_FCY = base.r_FCY;
  out.r_OD = base.r_OD;
  out.β_IR = base.β_IR;
  for (const r of rows) {
    out.spot += r.spot;
    out.fwd += r.fwd;
    out.nonCash += r.nonCash;
    out.nonCashAsset = (out.nonCashAsset ?? 0) + (r.nonCashAsset ?? 0);
    out.cash += r.cash;
    out.payout += r.payout;
    out.collections += r.collections;
    out.nonLpCash += r.nonLpCash;
    out.fcastFX += r.fcastFX;
    out.ir_asset_notional += r.ir_asset_notional;
    out.ir_liab_notional += r.ir_liab_notional;
    out.ir_invest_notional = (out.ir_invest_notional ?? 0) + (r.ir_invest_notional ?? 0);
  }
  // Rates: keep first entity's LP rates (notional-weighted average not needed for Task 01).
  return out;
}

/**
 * Build the parent-company consolidated FX book by summing every NordTech
 * subsidiary seed (and any live entity identity match) by currency.
 */
export function consolidateEntityBooks(entities: Entity[]): ConsolidatedBook {
  const byCcy = new Map<string, RowState[]>();
  const sourcesByCcy: Record<string, string[]> = {};
  let usdCash = 0;
  let usdNonLpCash = 0;
  let usdPayout = 0;
  let usdCollections = 0;

  for (const e of entities) {
    const seed = simSeedForEntity(e);
    usdCash += seed.usdCash;
    usdNonLpCash += seed.usdNonLpCash;
    usdPayout += seed.usdParams.payout;
    usdCollections += seed.usdParams.collections;
    const label = e.name;
    for (const r of seed.rows) {
      const list = byCcy.get(r.ccy) ?? [];
      list.push(r);
      byCcy.set(r.ccy, list);
      sourcesByCcy[r.ccy] = [...(sourcesByCcy[r.ccy] ?? []), label];
    }
  }

  const rows = [...byCcy.entries()]
    .map(([, list]) => mergeRows(list))
    .sort((a, b) => a.ccy.localeCompare(b.ccy));

  return {
    rows,
    usdCash,
    usdNonLpCash,
    usdParams: {
      ...INITIAL_USD_PARAMS,
      payout: usdPayout,
      collections: usdCollections,
    },
    sourcesByCcy,
  };
}

/**
 * Risk layer for the consolidated dashboard: stock / 3m-avg exposure and
 * 1M 95% VaR per currency (curriculum VaR, not LP overlay portfolio VAR).
 */
export function computeConsolidatedRisk(
  entities: Entity[],
  setupOrConfidence: VarSetup | VarConfidencePct = 95,
): CurrencyRiskRow[] {
  const setup: VarSetup =
    typeof setupOrConfidence === 'number'
      ? { ...DEFAULT_VAR_SETUP, confidencePct: setupOrConfidence }
      : setupOrConfidence;
  const book = consolidateEntityBooks(entities);
  // Build synthetic ladder inputs from consolidated stock/flow fields.
  const accounts = book.rows.flatMap(r => {
    const out: Parameters<typeof computeStockLadder>[0] = [];
    // Stock mismatch legs used by Task 01:
    // EUR: cash + receivables − venture debt (= Net FX stock)
    // PLN: nonCash liability (payroll accrual)
    // Other: cash + nonCashAsset + nonCash + invest − debt
    if (r.ccy === 'EUR') {
      if (Math.abs(r.cash) > 1e-9) {
        out.push({
          id: `${r.ccy}-cash`, seedKey: `${r.ccy}-cash`, entityId: 'consol',
          name: 'Cash', kind: 'asset', currency: r.ccy, amount: r.cash,
          cadence: 'stock', ladderLayer: 'stock',
        });
      }
      if (Math.abs(r.nonCashAsset ?? 0) > 1e-9) {
        out.push({
          id: `${r.ccy}-recv`, seedKey: `${r.ccy}-recv`, entityId: 'consol',
          name: 'Receivables', kind: 'asset', currency: r.ccy,
          amount: r.nonCashAsset ?? 0, cadence: 'stock', ladderLayer: 'stock',
        });
      }
      if (Math.abs(r.ir_liab_notional) > 1e-9) {
        out.push({
          id: `${r.ccy}-debt`, seedKey: `${r.ccy}-debt`, entityId: 'consol',
          name: 'Venture debt', kind: 'liability', currency: r.ccy,
          // Positive debt notional = short FX → negative stock contribution
          amount: -r.ir_liab_notional, cadence: 'stock', ladderLayer: 'stock',
        });
      }
      if (Math.abs(r.collections) > 1e-9) {
        out.push({
          id: `${r.ccy}-flow`, seedKey: `${r.ccy}-flow`, entityId: 'consol',
          name: 'Revenue', kind: 'flow', currency: r.ccy, amount: r.collections,
          cadence: 'monthly', ladderLayer: 'flow',
        });
      }
    } else if (r.ccy === 'PLN') {
      const short = r.nonCash !== 0 ? r.nonCash : r.cash;
      out.push({
        id: `${r.ccy}-payroll`, seedKey: `${r.ccy}-payroll`, entityId: 'consol',
        name: 'Payroll', kind: 'liability', currency: r.ccy, amount: short,
        cadence: 'monthly', ladderLayer: 'stock',
      });
    } else {
      const stock =
        r.cash
        + (r.nonCashAsset ?? 0)
        + r.nonCash
        + (r.ir_invest_notional ?? 0)
        - r.ir_liab_notional;
      if (Math.abs(stock) > 1e-9) {
        out.push({
          id: `${r.ccy}-stock`, seedKey: `${r.ccy}-stock`, entityId: 'consol',
          name: r.ccy, kind: 'asset', currency: r.ccy, amount: stock,
          cadence: 'stock', ladderLayer: 'stock',
        });
      }
    }
    return out;
  });

  // USD hub from parent cash / payroll (not a mismatch bar, but shown for context).
  const us = entities.find(e => classifyNordtechEntity(e) === 'US');
  if (us) {
    const seed = simSeedForEntity(us);
    if (Math.abs(seed.usdCash) > 1e-9) {
      accounts.push({
        id: 'usd-cash', seedKey: 'usd-cash', entityId: us.id,
        name: 'US cash', kind: 'asset', currency: 'USD', amount: seed.usdCash,
        cadence: 'stock', ladderLayer: 'stock',
      });
    }
    if (Math.abs(seed.usdParams.payout) > 1e-9) {
      accounts.push({
        id: 'usd-payroll', seedKey: 'usd-payroll', entityId: us.id,
        name: 'US payroll', kind: 'flow', currency: 'USD',
        amount: seed.usdParams.payout, cadence: 'monthly', ladderLayer: 'flow',
      });
    }
  }

  const bars = computeStockLadder(accounts);
  return bars.map(bar => ({
    bar,
    varStock: computeTaskVar(bar, { ...setup, exposureBasis: 'stock' }),
    varAvg3m: computeTaskVar(bar, { ...setup, exposureBasis: 'avgBuildup' }),
  }));
}
