import type { LadderBar, TestAccount } from '@/lib/test-mode/types';

/**
 * Group-level unified exposure ladder (all entities netted).
 *
 * Stock bars follow the episode mismatch definition — operating FX layers only:
 * EUR = Frankfurt cash + EU receivables (+€4.9M); PLN payroll accrual (−zł1.8M).
 * Venture debt and GBP stake are ladderLayer 'none' and excluded.
 *
 * 3-month average: avg ≈ S + 1.5F (guide). Monthly stock items (e.g. PLN payroll
 * accrual) also contribute to F so PLN avg = −1.8 + 1.5×(−1.8) = −4.5.
 */
export function computeStockLadder(accounts: TestAccount[]): LadderBar[] {
  const byCcy = new Map<string, { stock: number; flow: number }>();

  for (const a of accounts) {
    const row = byCcy.get(a.currency) ?? { stock: 0, flow: 0 };
    if (a.ladderLayer === 'stock') {
      row.stock += a.amount;
      // Recurring stock obligations also drive the monthly flow leg of 3m avg.
      if (a.cadence === 'monthly') row.flow += a.amount;
    } else if (a.ladderLayer === 'flow') {
      row.flow += a.amount;
    }
    byCcy.set(a.currency, row);
  }

  const bars: LadderBar[] = [];
  for (const [ccy, { stock, flow }] of byCcy) {
    const avg3mM = stock + 1.5 * flow;
    let direction: LadderBar['direction'] = 'hub';
    if (Math.abs(stock) < 1e-9 && Math.abs(flow) > 1e-9) {
      direction = 'hub';
    } else if (stock > 1e-9) {
      direction = 'long';
    } else if (stock < -1e-9) {
      direction = 'short';
    } else {
      direction = 'hub';
    }
    // USD is the reporting hub even when cash stock is long.
    if (ccy === 'USD') direction = 'hub';
    bars.push({ ccy, stockNetM: stock, flowM: flow, avg3mM, direction });
  }

  // Largest mismatch first by |stock|, then alpha.
  bars.sort((a, b) => {
    const d = Math.abs(b.stockNetM) - Math.abs(a.stockNetM);
    return d !== 0 ? d : a.ccy.localeCompare(b.ccy);
  });
  return bars;
}

/** Largest |stock| bar — guide answer: EUR +€4.9M. */
export function largestMismatch(bars: LadderBar[]): LadderBar | undefined {
  return bars.reduce<LadderBar | undefined>((best, b) => {
    if (b.ccy === 'USD') return best; // hub is never the primary mismatch
    if (!best) return b;
    return Math.abs(b.stockNetM) > Math.abs(best.stockNetM) ? b : best;
  }, undefined);
}
