import { describe, expect, it } from 'vitest';
import {
  isReleasedToHedgingDecision,
  markPreparedApproval,
  stageAtlasMixPrepared,
  stagedFxHedgeCarryByCcyUsdM,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';

function stubProfile(impliedCarryUsdM?: number): PreparedHedgeProfile {
  return {
    structure: 'bullet',
    basis: 'cash',
    ticketBasis: 'stock',
    legs: [],
    coverLocalM: 10,
    hedgeRatio: 1,
    impliedCarryUsdM,
  };
}

describe('hedge approval release', () => {
  it('treats missing status as already on Hedging Decision', () => {
    expect(isReleasedToHedgingDecision(stubProfile())).toBe(true);
    expect(isReleasedToHedgingDecision({ ...stubProfile(), approvalStatus: 'approved' })).toBe(true);
    expect(isReleasedToHedgingDecision({ ...stubProfile(), approvalStatus: 'draft' })).toBe(false);
    expect(isReleasedToHedgingDecision({ ...stubProfile(), approvalStatus: 'pending' })).toBe(false);
  });

  it('promotes only drafts when sending for approval', () => {
    const next = markPreparedApproval(
      {
        EUR: { ...stubProfile(), approvalStatus: 'draft' },
        GBP: { ...stubProfile(), approvalStatus: 'approved' },
      },
      { status: 'pending', who: 'CFO', from: 'draft' },
    );
    expect(next.EUR?.approvalStatus).toBe('pending');
    expect(next.EUR?.approvalWho).toBe('CFO');
    expect(next.GBP?.approvalStatus).toBe('approved');
  });

  it('skips deselected portfolio CCYs', () => {
    const next = markPreparedApproval(
      {
        EUR: { ...stubProfile(), approvalStatus: 'draft', preparedFor: 'liquidity' },
        GBP: { ...stubProfile(), approvalStatus: 'draft', preparedFor: 'liquidity' },
      },
      {
        status: 'approved',
        who: 'Treasury',
        from: 'draft',
        onlyCcys: new Set(['EUR']),
        preparedFor: 'liquidity',
      },
    );
    expect(next.EUR?.approvalStatus).toBe('approved');
    expect(next.GBP?.approvalStatus).toBe('draft');
  });
});

describe('stageAtlasMixPrepared', () => {
  it('stages Optimize-mix bullets and drops leftover carry tickets', () => {
    const next = stageAtlasMixPrepared(
      {
        MXN: {
          ...stubProfile(),
          preparedFor: 'carry',
          coverLocalM: 146.61,
          hedgeRatio: 1,
        },
      },
      [
        { ccy: 'JPY', weight: 0.16, coverLocalM: -293.12, lockedCarryUsdM: -0.016 },
        { ccy: 'MXN', weight: 0.2, coverLocalM: 29.46, lockedCarryUsdM: -0.02 },
        { ccy: 'EUR', weight: 1, coverLocalM: 12.1, lockedCarryUsdM: 0.11 },
        { ccy: 'GBP', weight: 0, coverLocalM: 0, lockedCarryUsdM: 0 },
      ],
      12,
    );
    expect(next.JPY).toMatchObject({
      structure: 'bullet',
      basis: 'totalExpected',
      coverLocalM: -293.12,
      hedgeRatio: 0.16,
      impliedCarryUsdM: -0.016,
      preparedFor: 'var',
      approvalStatus: 'draft',
    });
    expect(next.MXN?.coverLocalM).toBeCloseTo(29.46);
    expect(next.MXN?.preparedFor).toBe('var');
    expect(next.EUR?.coverLocalM).toBeCloseTo(12.1);
    expect(next.GBP).toBeUndefined();
  });

  it('keeps an FX Risk strip when preserveStrips is set', () => {
    const strip: PreparedHedgeProfile = {
      ...stubProfile(0.18),
      structure: 'strip',
      preparedFor: 'var',
      coverLocalM: 12.1,
      hedgeRatio: 1,
      legs: [
        {
          index: 0,
          startMonth: 0,
          endMonth: 3,
          settleMonths: 3,
          hedgeLocalM: 4,
          label: 'L1',
        },
        {
          index: 1,
          startMonth: 3,
          endMonth: 12,
          settleMonths: 12,
          hedgeLocalM: 12.1,
          label: 'L2',
        },
      ],
    };
    const next = stageAtlasMixPrepared(
      { EUR: strip },
      [{ ccy: 'EUR', weight: 1, coverLocalM: 12.1, lockedCarryUsdM: 0.21 }],
      12,
      { preserveStrips: true },
    );
    expect(next.EUR?.structure).toBe('strip');
    expect(next.EUR?.legs).toHaveLength(2);
    expect(next.EUR?.impliedCarryUsdM).toBeCloseTo(0.18);
  });

  it('replaces an FX Risk strip with a mix bullet unless preserveStrips', () => {
    const strip: PreparedHedgeProfile = {
      ...stubProfile(0.18),
      structure: 'strip',
      preparedFor: 'var',
      coverLocalM: 12.1,
    };
    const next = stageAtlasMixPrepared(
      { EUR: strip },
      [{ ccy: 'EUR', weight: 1, coverLocalM: 12.1, lockedCarryUsdM: 0.21 }],
      12,
    );
    expect(next.EUR?.structure).toBe('bullet');
    expect(next.EUR?.impliedCarryUsdM).toBeCloseTo(0.21);
  });
});

describe('stagedFxHedgeCarryByCcyUsdM', () => {
  it('maps finite implied FWD-points carry, including zero', () => {
    expect(
      stagedFxHedgeCarryByCcyUsdM({
        EUR: stubProfile(0.042),
        PLN: stubProfile(0),
        GBP: stubProfile(undefined),
      }),
    ).toEqual({ EUR: 0.042, PLN: 0 });
  });

  it('returns an empty map when nothing is staged', () => {
    expect(stagedFxHedgeCarryByCcyUsdM()).toEqual({});
    expect(stagedFxHedgeCarryByCcyUsdM({})).toEqual({});
  });
});
