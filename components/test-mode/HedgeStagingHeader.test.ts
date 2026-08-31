import { describe, expect, it } from 'vitest';
import type { HedgePathSummaryMetrics } from '@/components/test-mode/ExposureHedgePathChart';
import { pathChartDraftDirty } from '@/components/test-mode/HedgeStagingHeader';
import type { PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';

function stubBullet(
  extras: Partial<PreparedHedgeProfile> = {},
): PreparedHedgeProfile {
  return {
    structure: 'bullet',
    basis: 'totalExpected',
    ticketBasis: 'totalBuildup',
    legs: [],
    coverLocalM: 12.1,
    hedgeRatio: 1,
    settleMonths: 12,
    ...extras,
  };
}

function stubMetrics(
  extras: Partial<HedgePathSummaryMetrics> = {},
): HedgePathSummaryMetrics {
  return {
    coverTitle: 'Hedge',
    coverValue: '12.1',
    coverPct: '100%',
    coverSub: '',
    coverLocalM: 12.1,
    legsTitle: 'Forwards',
    legsValue: '1',
    legsSub: 'bullet',
    legCount: 1,
    structure: 'bullet',
    basis: 'totalExpected',
    settleMonths: 12,
    legsSig: '12.0000:12.100000',
    residVarValue: '—',
    residVarPct: null,
    residVarSub: '',
    breakevenValue: '—',
    breakevenSub: null,
    ...extras,
  };
}

describe('pathChartDraftDirty', () => {
  it('is clean when the live path matches the staged bullet', () => {
    expect(pathChartDraftDirty(stubBullet(), stubMetrics())).toBe(false);
  });

  it('flags settle-tenor edits that leave cover unchanged', () => {
    expect(
      pathChartDraftDirty(
        stubBullet(),
        stubMetrics({
          settleMonths: 6,
          legsSig: '6.0000:12.100000',
        }),
      ),
    ).toBe(true);
  });

  it('flags bullet → strip even when cover is the same', () => {
    expect(
      pathChartDraftDirty(
        stubBullet(),
        stubMetrics({
          structure: 'strip',
          legCount: 3,
          settleMonths: undefined,
          legsSig: '4.0000:4.000000|8.0000:8.000000|12.0000:12.100000',
        }),
      ),
    ).toBe(true);
  });
});
