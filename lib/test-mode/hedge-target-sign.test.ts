import { describe, expect, it } from 'vitest';
import {
  buildHedgeVarSummary,
  mixCoverTargetLocalM,
  pendingHedgeCoverLocalM,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';
import { computeTaskVar } from '@/lib/test-mode/task-var';
import { DEFAULT_VAR_SETUP, type VarSetup } from '@/lib/test-mode/var-setup';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import type { LadderBar } from '@/lib/test-mode/types';
import { buildTenorRiskLadder } from '@/lib/test-mode/tenor-risk-ladder';
import { CURRENCY_PARAMS, makeSimRow } from '@/lib/fx-buffer';

/**
 * Reproduces the EUR row the desk reported:
 *   STOCK +1.90M · FLOW +10.20M (12 x 0.85) · one live booked bullet of 12.10M
 * and pins the sign convention that `targetHedgeLocalM` depends on.
 */
const SETUP: VarSetup = {
  ...DEFAULT_VAR_SETUP,
  forecastMonths: 12,
  exposureBasis: 'totalBuildup',
};

const STOCK_M = 1.9;
const MONTHLY_FLOW_M = 0.85;
const FLOWS = Array.from({ length: 12 }, () => MONTHLY_FLOW_M);
/** stock + Σflows — what accruedPositionFromScheduleM returns for this book. */
const EXPOSURE_M = STOCK_M + MONTHLY_FLOW_M * 12; // 12.10

function eurRisk(): CurrencyRiskRow[] {
  const bar: LadderBar = {
    ccy: 'EUR',
    stockNetM: STOCK_M,
    avg3mM: STOCK_M + MONTHLY_FLOW_M * 1.5,
    flowM: MONTHLY_FLOW_M,
    direction: 'long',
  };
  return [
    {
      bar,
      varStock: computeTaskVar(bar, { ...SETUP, exposureBasis: 'stock' }),
      varAvg3m: computeTaskVar(bar, SETUP),
    },
  ];
}

function bullet(amountLocalM: number): HedgeTicket {
  return {
    id: 'eur-bullet',
    ccy: 'EUR',
    instrument: 'forward',
    basis: 'totalBuildup',
    amountLocalM,
    maturity: '1y',
    maturityLabel: '1Y · bullet Tf',
    varUsdM: 0,
    addressesHigherVar: true,
    status: 'booked',
  };
}

function targetFor(booked: HedgeTicket[]): number {
  const summary = buildHedgeVarSummary(
    eurRisk(),
    {},
    SETUP,
    booked,
    { EUR: FLOWS },
  );
  const row = summary.rows.find(r => r.ccy === 'EUR');
  expect(row).toBeDefined();
  return row!.targetHedgeLocalM;
}

describe('targetHedgeLocalM sign convention', () => {
  it('unhedged target is the accrued exposure', () => {
    expect(targetFor([])).toBeCloseTo(EXPOSURE_M, 6);
  });

  it('a positive (SELL, per the label rule) cover drives the target to zero', () => {
    // HedgingDecisionLayer.tsx:170 renders SELL when amountLocalM >= 0, and
    // TradeTicketPanel builds a Sell as +|size|. Under that convention a full
    // cover must leave nothing to hedge.
    expect(targetFor([bullet(EXPOSURE_M)])).toBeCloseTo(0, 6);
  });

  it('a BUY option (−N) still covers — leftover Target goes to zero, not 2×E', () => {
    expect(targetFor([bullet(-EXPOSURE_M)])).toBeCloseTo(0, 6);
  });

  it('a half cover leaves half — the reduction is linear in the cover', () => {
    expect(targetFor([bullet(EXPOSURE_M / 2)])).toBeCloseTo(EXPOSURE_M / 2, 6);
  });

  it('booking any signed full cover never grows leftover Target past the open book', () => {
    const open = Math.abs(targetFor([]));
    expect(Math.abs(targetFor([bullet(EXPOSURE_M)]))).toBeLessThanOrEqual(open + 1e-9);
    expect(Math.abs(targetFor([bullet(-EXPOSURE_M)]))).toBeLessThanOrEqual(open + 1e-9);
  });
});

/**
 * The Hedging Decision row's "Locked carry" / "M2M" stat blocks read
 * buildTenorRiskLadder's cashCarryUsdM / m2mUsdM at the tenor closest to Tf.
 * These pin: (1) VAR_HORIZON_OPTIONS has an exact months=Tf point so that
 * "closest" pick is unambiguous for the common Tf=12 case, and (2) m2mUsdM
 * — the non-carry P&L — is the mark on the UNCOVERED residual only, computed
 * against the SAME real formula the desk-facing tooltip describes.
 */
describe('tenor ladder m2mUsdM — the non-carry P&L component', () => {
  const row = makeSimRow('eur-row', 'EUR', STOCK_M, 0, 0, 0, 0);

  it('a fully, correctly-signed covered book has zero M2M — nothing is left uncovered', () => {
    const ladder = buildTenorRiskLadder({
      ccy: 'EUR',
      row,
      stockM: STOCK_M,
      monthlyFlowM: MONTHLY_FLOW_M,
      monthlyFlows: FLOWS,
      setup: SETUP,
      bookedHedges: [bullet(EXPOSURE_M)],
      prepared: null,
      forecastProfile: null,
      marketRates: null,
    });
    const at12m = ladder.find(p => p.months === 12);
    expect(at12m).toBeDefined();
    expect(at12m!.m2mUsdM).toBeCloseTo(0, 9);
    expect(Number.isFinite(at12m!.cashCarryUsdM)).toBe(true);
  });

  it('an uncovered book marks the full residual via CIP (no market curve loaded)', () => {
    const ladder = buildTenorRiskLadder({
      ccy: 'EUR',
      row,
      stockM: STOCK_M,
      monthlyFlowM: MONTHLY_FLOW_M,
      monthlyFlows: FLOWS,
      setup: SETUP,
      bookedHedges: [],
      prepared: null,
      forecastProfile: null,
      marketRates: null,
    });
    const at12m = ladder.find(p => p.months === 12);
    expect(at12m).toBeDefined();
    // cipM2mUsdM(residual, ccy, months, rFcyPct) = residual * spotUsd
    //   * (rFcyPct - rUsdPct) / 100 * months/12 — hand-derived from the same
    // CURRENCY_PARAMS the engine reads, not a copied-in magic number.
    const spotUsd = 1.0; // curriculum pin for EUR (analyticsSpotUsd)
    const rFcyPct = CURRENCY_PARAMS.EUR!.carry;
    const rUsdPct = CURRENCY_PARAMS.USD!.carry;
    const expected =
      EXPOSURE_M * spotUsd * ((rFcyPct - rUsdPct) / 100) * (12 / 12);
    expect(at12m!.m2mUsdM).toBeCloseTo(expected, 6);
    expect(Math.abs(at12m!.m2mUsdM)).toBeGreaterThan(1e-6);
  });
});

describe('forecast → pending hedge on a booked EUR book', () => {
  it('keeps gross Target N after a live bullet, so pending is the unbooked clip', () => {
    const summary = buildHedgeVarSummary(
      eurRisk(),
      { EUR: 1 },
      SETUP,
      [bullet(EXPOSURE_M)],
      { EUR: FLOWS },
    );
    const row = summary.rows.find(r => r.ccy === 'EUR')!;
    expect(row.forecastTargetLocalM).toBeCloseTo(EXPOSURE_M, 6);
    expect(row.targetHedgeLocalM).toBeCloseTo(0, 6);
    expect(row.bookedCoverLocalM).toBeCloseTo(EXPOSURE_M, 6);
    expect(mixCoverTargetLocalM(row)).toBeCloseTo(EXPOSURE_M, 6);
    expect(
      pendingHedgeCoverLocalM(
        mixCoverTargetLocalM(row),
        row.bookedCoverLocalM ?? 0,
        1,
      ),
    ).toBeCloseTo(0, 6);
  });

  it('grows pending when the forecast lengthens while mix % and booked stay put', () => {
    const booked = [bullet(EXPOSURE_M)];
    const at12 = buildHedgeVarSummary(
      eurRisk(),
      { EUR: 1 },
      SETUP,
      booked,
      { EUR: FLOWS },
    ).rows.find(r => r.ccy === 'EUR')!;
    const longerFlows = Array.from({ length: 24 }, () => MONTHLY_FLOW_M);
    const at24 = buildHedgeVarSummary(
      eurRisk(),
      { EUR: 1 },
      { ...SETUP, forecastMonths: 24 },
      booked,
      { EUR: longerFlows },
    ).rows.find(r => r.ccy === 'EUR')!;
    const e24 = STOCK_M + MONTHLY_FLOW_M * 24;
    expect(mixCoverTargetLocalM(at12)).toBeCloseTo(EXPOSURE_M, 6);
    expect(mixCoverTargetLocalM(at24)).toBeCloseTo(e24, 6);
    expect(at24.bookedCoverLocalM).toBeCloseTo(EXPOSURE_M, 6);
    expect(
      pendingHedgeCoverLocalM(
        mixCoverTargetLocalM(at24),
        at24.bookedCoverLocalM ?? 0,
        1,
      ),
    ).toBeCloseTo(e24 - EXPOSURE_M, 6);
  });

  it('keeps pre-hedge Stock; a BUY option does not flip +1.9 into +14', () => {
    const stock = 14;
    const flow = 0.65;
    const bookedAmt = -12.1;
    const bar: LadderBar = {
      ccy: 'EUR',
      stockNetM: stock,
      avg3mM: stock + flow * 1.5,
      flowM: flow,
      direction: 'long',
    };
    const risk: CurrencyRiskRow[] = [
      {
        bar,
        varStock: computeTaskVar(bar, { ...SETUP, exposureBasis: 'stock' }),
        varAvg3m: computeTaskVar(bar, SETUP),
      },
    ];
    const setup1m = { ...SETUP, forecastMonths: 1 };
    const booked = [bullet(bookedAmt)];
    const flows = { EUR: [flow] };
    const leftover = buildHedgeVarSummary(
      risk,
      {},
      setup1m,
      booked,
      flows,
    ).rows.find(r => r.ccy === 'EUR')!;
    expect(leftover.forecastTargetLocalM).toBeCloseTo(14.65, 6);
    expect(leftover.stockHedgeLocalM).toBeCloseTo(14, 6);
    expect(leftover.targetHedgeLocalM).toBeCloseTo(2.55, 6);
    expect(leftover.residualLocalM).toBeCloseTo(2.55, 6);
    expect(leftover.exposureLocalM).toBeLessThan(leftover.openExposureLocalM);
    expect(
      pendingHedgeCoverLocalM(
        mixCoverTargetLocalM(leftover),
        leftover.bookedCoverLocalM ?? 0,
        1,
      ),
    ).toBeCloseTo(2.55, 6);
    const covered = buildHedgeVarSummary(
      risk,
      { EUR: 1 },
      setup1m,
      booked,
      flows,
    ).rows.find(r => r.ccy === 'EUR')!;
    expect(covered.residualLocalM).toBeCloseTo(0, 6);
  });

  it('does not add a BUY option onto NordTech cash Stock (1.9 − (−12.1) ≠ 14)', () => {
    const bookedAmt = -EXPOSURE_M;
    const row = buildHedgeVarSummary(
      eurRisk(),
      {},
      SETUP,
      [bullet(bookedAmt)],
      { EUR: FLOWS },
    ).rows.find(r => r.ccy === 'EUR')!;
    expect(row.stockHedgeLocalM).toBeCloseTo(STOCK_M, 6);
    expect(row.stockHedgeLocalM).not.toBeCloseTo(STOCK_M - bookedAmt, 6);
    expect(row.targetHedgeLocalM).toBeCloseTo(0, 6);
    expect(row.residualLocalM).toBeCloseTo(0, 6);
  });
});
