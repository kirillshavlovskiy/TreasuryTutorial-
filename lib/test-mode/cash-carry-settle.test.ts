import { describe, expect, it } from 'vitest';
import {
  buildSettleWamScenarios,
  optimizeStripShapeAroundWam,
  scoreStripShapeAroundWam,
  validateSettleWamVsFwd,
} from '@/lib/test-mode/cash-carry-analytics';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import type { PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';
import { getActiveMarketRates } from '@/lib/fx-market-rates';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import type { RowState } from '@/lib/fx-buffer';

function stubRow(ccy: string, cash: number, collections: number): RowState {
  return {
    ccy,
    cash,
    spot: cash,
    collections,
    payout: 0,
    fcastFX: 0,
  } as RowState;
}

describe('buildSettleWamScenarios', () => {
  it('bullet M1·start: 12 periods, 0 FWD pts; overhedge FCY int negative', () => {
    const marketRates = getActiveMarketRates();
    const setup = {
      ...DEFAULT_VAR_SETUP,
      forecastMonths: 12,
      horizon: '1y' as const,
    };
    const bookRows = [stubRow('EUR', 2.5, 1.2)];
    const risk = [
      {
        bar: {
          ccy: 'EUR',
          stockNetM: 2.5,
          flowM: 14.4,
          openExposureLocalM: 16.9,
        },
      },
    ] as CurrencyRiskRow[];
    const preparedByCcy: Record<string, PreparedHedgeProfile> = {
      EUR: {
        structure: 'bullet',
        basis: 'totalExpected',
        ticketBasis: 'totalBuildup',
        legs: [],
        coverLocalM: 16.3,
        hedgeRatio: 1,
        settleMonths: 12,
      },
    };

    const rows = buildSettleWamScenarios({
      ccy: 'EUR',
      risk,
      setup,
      bookedHedges: [],
      preparedByCcy,
      marketRates,
      bookRows,
    });

    // Bullet ladder = 12 periods M1…M12 (no M0 row).
    expect(rows).toHaveLength(12);
    expect(rows[0]!.settleMonths).toBe(1);
    expect(rows[11]!.settleMonths).toBe(12);

    const start = rows.find(r => r.settleMonths === 1)!;
    expect(start.settleScheduleLabel).toBe('M1·start');
    expect(start.fwdCarryUsdM).toBe(0);
    expect(start.fcyInterestUsdM).toBeLessThan(0);
    expect(start.usdInterestUsdM).toBeGreaterThan(0);
    // FWD = 0 at start → Enhancement = interest delta only.
    expect(start.enhancementUsdM).toBeCloseTo(start.interestDeltaUsdM, 8);
    expect(start.totalUsdM).toBeCloseTo(start.enhancementUsdM, 8);

    const book = rows.find(r => r.isCurrentWam)!;
    expect(book.settleMonths).toBe(12);
    expect(book.fwdCarryUsdM).toBeGreaterThan(0);
    // Enhancement includes FWD pts.
    expect(book.enhancementUsdM).toBeCloseTo(
      book.interestDeltaUsdM + book.fwdCarryUsdM,
      8,
    );

    const cip = validateSettleWamVsFwd({
      scenarios: rows,
      marketRates,
      ccy: 'EUR',
      Tf: 12,
    });
    expect(cip).toBeTruthy();
    expect(cip!.cashSpreadsBeatMidFwd).toBe(false);
    expect(cip!.overnightSpreadSyntheticUsdM).toBeLessThan(
      cip!.tfFwdMidUsdM,
    );
  });

  it('strip: book keeps staggered tenors; M0 is spot collapse; Enhancement includes FWD', () => {
    const marketRates = getActiveMarketRates();
    const setup = {
      ...DEFAULT_VAR_SETUP,
      forecastMonths: 12,
      horizon: '1y' as const,
    };
    const bookRows = [stubRow('EUR', 2.5, 1.2)];
    const risk = [
      {
        bar: {
          ccy: 'EUR',
          stockNetM: 2.5,
          flowM: 25.66,
          openExposureLocalM: 28.16,
        },
      },
    ] as CurrencyRiskRow[];
    const preparedByCcy: Record<string, PreparedHedgeProfile> = {
      EUR: {
        structure: 'strip',
        basis: 'totalExpected',
        ticketBasis: 'totalBuildup',
        coverLocalM: 23.23,
        hedgeRatio: 1,
        settleMonths: 8,
        legs: [
          {
            startMonth: 0,
            endMonth: 3,
            settleMonths: 3,
            hedgeLocalM: 4.4,
            tradeNotionalLocalM: 4.4,
          },
          {
            startMonth: 0,
            endMonth: 6,
            settleMonths: 6,
            hedgeLocalM: 8.89,
            tradeNotionalLocalM: 4.49,
          },
          {
            startMonth: 0,
            endMonth: 9,
            settleMonths: 9,
            hedgeLocalM: 15.02,
            tradeNotionalLocalM: 6.13,
          },
          {
            startMonth: 0,
            endMonth: 12,
            settleMonths: 12,
            hedgeLocalM: 23.23,
            tradeNotionalLocalM: 8.21,
          },
        ],
      },
    };

    const rows = buildSettleWamScenarios({
      ccy: 'EUR',
      risk,
      setup,
      bookedHedges: [],
      preparedByCcy,
      marketRates,
      bookRows,
    });

    const m0 = rows.find(r => r.settleMonths === 0)!;
    const book = rows.find(r => r.isCurrentWam)!;

    expect(m0.settleScheduleLabel).toBe('M0·start');
    expect(book.settleScheduleLabel).toBe('M3/M6/M9/M12');
    expect(book.fwdCarryUsdM).toBeGreaterThan(m0.fwdCarryUsdM);
    expect(book.settleScheduleLabel).toContain('M3');
    // Spot OD inflates interest-only delta; Enhancement includes FWD so CIP-close.
    expect(m0.interestDeltaUsdM).toBeGreaterThan(book.interestDeltaUsdM);
    expect(book.enhancementUsdM).toBeCloseTo(
      book.interestDeltaUsdM + book.fwdCarryUsdM,
      6,
    );
    expect(Math.abs(m0.enhancementUsdM - book.enhancementUsdM)).toBeLessThan(
      0.15 * Math.max(Math.abs(book.enhancementUsdM), 0.05),
    );

    const cip = validateSettleWamVsFwd({
      scenarios: rows,
      marketRates,
      ccy: 'EUR',
      Tf: 12,
    });
    expect(cip!.spotBeatsBookOnTotal).toBe(false);
    expect(cip!.pass).toBe(true);
  });

  it('ladderMode bullet: strip package still yields static one-leg M1…M12 curve', () => {
    const marketRates = getActiveMarketRates();
    const setup = {
      ...DEFAULT_VAR_SETUP,
      forecastMonths: 12,
      horizon: '1y' as const,
    };
    const bookRows = [stubRow('EUR', 2.5, 1.2)];
    const risk = [
      {
        bar: {
          ccy: 'EUR',
          stockNetM: 2.5,
          flowM: 25.66,
          openExposureLocalM: 28.16,
        },
      },
    ] as CurrencyRiskRow[];
    const preparedByCcy: Record<string, PreparedHedgeProfile> = {
      EUR: {
        structure: 'strip',
        basis: 'totalExpected',
        ticketBasis: 'totalBuildup',
        coverLocalM: 23.23,
        hedgeRatio: 1,
        settleMonths: 8,
        legs: [
          {
            startMonth: 0,
            endMonth: 3,
            settleMonths: 3,
            hedgeLocalM: 4.4,
            tradeNotionalLocalM: 4.4,
          },
          {
            startMonth: 0,
            endMonth: 6,
            settleMonths: 6,
            hedgeLocalM: 8.89,
            tradeNotionalLocalM: 4.49,
          },
          {
            startMonth: 0,
            endMonth: 12,
            settleMonths: 12,
            hedgeLocalM: 23.23,
            tradeNotionalLocalM: 14.34,
          },
        ],
      },
    };

    const rows = buildSettleWamScenarios({
      ccy: 'EUR',
      risk,
      setup,
      bookedHedges: [],
      preparedByCcy,
      marketRates,
      bookRows,
      ladderMode: 'bullet',
    });

    expect(rows).toHaveLength(12);
    expect(rows[0]!.settleMonths).toBe(1);
    expect(rows.every(r => r.structure === 'bullet')).toBe(true);
    expect(rows.every(r => r.legCount === 1)).toBe(true);
    expect(rows[0]!.settleScheduleLabel).toBe('M1·start');
    expect(rows.find(r => r.settleMonths === 6)?.settleScheduleLabel).toBe(
      'M6',
    );
    // Book WAM marker follows strip WAM, but schedule on the ladder is bullet.
    const book = rows.find(r => r.isCurrentWam)!;
    expect(book.settleScheduleLabel).toMatch(/^M\d+/);
    expect(book.settleScheduleLabel).not.toContain('/');
  });
});

describe('optimizeStripShapeAroundWam', () => {
  it('returns a best shape pinned near the target WAM', () => {
    const marketRates = getActiveMarketRates();
    const setup = {
      ...DEFAULT_VAR_SETUP,
      forecastMonths: 12,
      horizon: '1y' as const,
    };
    const bookRows = [stubRow('EUR', 2.5, 1.2)];
    const risk = [
      {
        bar: {
          ccy: 'EUR',
          stockNetM: 2.5,
          flowM: 14.4,
          openExposureLocalM: 16.9,
        },
      },
    ] as CurrencyRiskRow[];
    const preparedByCcy: Record<string, PreparedHedgeProfile> = {
      EUR: {
        structure: 'bullet',
        basis: 'totalExpected',
        ticketBasis: 'totalBuildup',
        legs: [],
        coverLocalM: 16.3,
        hedgeRatio: 1,
        settleMonths: 12,
      },
    };

    const opt = optimizeStripShapeAroundWam({
      ccy: 'EUR',
      risk,
      setup,
      bookedHedges: [],
      preparedByCcy,
      marketRates,
      bookRows,
      targetWamMonths: 6,
      maxLegCount: 4,
      topN: 3,
    });

    expect(opt).toBeTruthy();
    expect(opt!.targetWamMonths).toBe(6);
    expect(opt!.candidates.length).toBeGreaterThan(3);
    expect(opt!.best.enhancementUsdM).toBeGreaterThanOrEqual(
      opt!.bullet.enhancementUsdM - 1e-9,
    );
    expect(opt!.best.wamMonths).toBeGreaterThan(0);
    expect(Math.abs(opt!.best.wamMonths - 6)).toBeLessThan(2.5);

    const scored = scoreStripShapeAroundWam({
      ccy: 'EUR',
      risk,
      setup,
      bookedHedges: [],
      preparedByCcy,
      marketRates,
      bookRows,
      targetWamMonths: 6,
      legCount: 3,
      centerOfMass: 0.5,
      kurtosis: 0,
    });
    expect(scored?.structure).toBe('strip');
    expect(scored?.legCount).toBe(3);
    expect(scored?.settleMonths).toHaveLength(3);
  });
});

