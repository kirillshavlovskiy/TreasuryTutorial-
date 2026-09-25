import { describe, expect, it } from 'vitest';
import {
  attachPreparedPackages,
  approvalRiskHintForPackage,
  classifyHedgeFxRisk,
  clearLiveBulletForCcy,
  hasLiveCoverForCcy,
  GROUP_HEDGE_SCOPE,
  hedgeSkipsApprovalPolicy,
  isReleasedToHedgingDecision,
  markPreparedApproval,
  modeledHedgeCarryUsdM,
  packageForStructure,
  preparedHedgeFromBookedTickets,
  preferredStripEdgeTickets,
  chartTicketsAtEdge,
  fillTicketAtEdge,
  stripPackageForTicketView,
  setPreparedHedgeForCcy,
  sameHedgeProgramExecution,
  livePreparedHedge,
  settleMonthsFromHedgeTicket,
  stageAtlasMixPrepared,
  stripScheduleEndsFromPrepared,
  stripScheduleWeightsFromPrepared,
  scalePreparedHedgeToCover,
  scalePreparedHedgesBySizerMove,
  grossForecastTargetLocalM,
  bookableHedgeCoverLocalM,
  bookableAddHedgeCoverLocalM,
  committedHedgeNotionalLocalM,
  sessionExecutedCoverAbs,
  sessionPendingHedgeAbs,
  sessionStripClipAbs,
  sessionBookOverlayClipAbs,
  bookedStripResumeSeed,
  stripSchedulesAgree,
  resumePartWorkedStripOnBook,
  coveringHedgeSplitLocalM,
  hedgeCoverSnapshot,
  decisionBookOpenStructure,
  composeDecisionBookTicket,
  stripFullyExecuted,
  stripExecutionStarted,
  ticketOpensAsStrip,
  pendingHedgeCoverLocalM,
  mixCoverTargetLocalM,
  preparedTicketCoverLocalM,
  preparedByCcyAlignedToMix,
  mixRatiosAreActive,
  stampSourcePackage,
  stagedFxHedgeCarryByCcyUsdM,
  hedgeTicketExecutionState,
  decisionCcyOrderCounts,
  decisionStructureCaption,
  isEditableWorkingOrder,
  isMarketExecutedHedgeTicket,
  legPeersAtEdge,
  quoteAfterFill,
  spotReferencedFillQuote,
  OVER_AUTOMATED_LIMIT_NOTE,
  type HedgeTicket,
  type PreparedHedgeProfile,
  type StagedStripChoice,
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

describe('classifyHedgeFxRisk', () => {
  it('marks a same-sign cover as decreasing FX risk and skips policy', () => {
    const fx = classifyHedgeFxRisk(8, {
      exposureLocalM: 12,
      openVarUsdM: 0.7,
    });
    expect(fx.kind).toBe('decrease');
    expect(fx.residualVarUsdM).toBeCloseTo(0.7 * 4 / 12);
    expect(hedgeSkipsApprovalPolicy(fx.kind)).toBe(true);
  });

  it('treats opposite-signed cover as an offset when |cover| ≤ |open|', () => {
    const fx = classifyHedgeFxRisk(-8, {
      exposureLocalM: 12,
      openVarUsdM: 0.7,
    });
    expect(fx.kind).toBe('decrease');
    expect(fx.deltaVarUsdM).toBeLessThan(0);
    expect(hedgeSkipsApprovalPolicy(fx.kind)).toBe(true);
  });

  it('marks a overshoot or a view on a flat book as increasing FX risk', () => {
    const overshoot = classifyHedgeFxRisk(30, {
      exposureLocalM: 12,
      openVarUsdM: 0.7,
    });
    expect(overshoot.kind).toBe('increase');
    expect(hedgeSkipsApprovalPolicy(overshoot.kind)).toBe(false);

    const openView = classifyHedgeFxRisk(10, { exposureLocalM: 0, openVarUsdM: 0 });
    expect(openView.kind).toBe('increase');
  });

  it('uses forecast target when stock is much smaller than cover', () => {
    const fx = classifyHedgeFxRisk(16.3, {
      exposureLocalM: 3,
      targetLocalM: 16.3,
      openVarUsdM: 0.7,
    });
    expect(fx.kind).toBe('decrease');
    expect(fx.deltaVarUsdM).toBeCloseTo(-0.7);
  });

  it('uses a precomputed Euler delta (negative = diversifier)', () => {
    const fx = classifyHedgeFxRisk(5, { deltaVarUsdM: -0.12 });
    expect(fx.kind).toBe('decrease');
    expect(hedgeSkipsApprovalPolicy(fx.kind)).toBe(true);
  });

  it('does not treat a forecast-sized Cash Carry cover as an overshoot of stock', () => {
    const hint = approvalRiskHintForPackage(
      { coverLocalM: 16.3, hedgeRatio: 0, preparedFor: 'carry' },
      { exposureLocalM: 3, targetLocalM: 3, openVarUsdM: 0.26 },
    );
    const fx = classifyHedgeFxRisk(16.3, hint);
    expect(fx.kind).toBe('decrease');
    expect(fx.deltaVarUsdM).toBeLessThan(0);
  });

  it('keeps a ratio overshoot as increasing FX risk', () => {
    const hint = approvalRiskHintForPackage(
      { coverLocalM: 30, hedgeRatio: 2.5, preparedFor: 'var' },
      { exposureLocalM: 12, targetLocalM: 12, openVarUsdM: 0.7 },
    );
    const fx = classifyHedgeFxRisk(30, hint);
    expect(hint.targetLocalM).toBeCloseTo(12);
    expect(fx.kind).toBe('increase');
  });
});

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

describe('same hedge program keeps approval', () => {
  const approvedStrip = (): PreparedHedgeProfile => ({
    ...stubProfile(0.044),
    structure: 'strip',
    preparedFor: 'carry',
    coverLocalM: 6.35,
    hedgeRatio: 1,
    approvalStatus: 'approved',
    approvalWho: 'Treasury',
    legs: [
      {
        index: 0,
        startMonth: 0,
        endMonth: 3,
        settleMonths: 3,
        hedgeLocalM: 2.12,
        tradeNotionalLocalM: 2.12,
        label: 'L1',
      },
      {
        index: 1,
        startMonth: 0,
        endMonth: 6,
        settleMonths: 6,
        hedgeLocalM: 4.23,
        tradeNotionalLocalM: 2.11,
        label: 'L2',
      },
      {
        index: 2,
        startMonth: 0,
        endMonth: 12,
        settleMonths: 12,
        hedgeLocalM: 6.35,
        tradeNotionalLocalM: 2.12,
        label: 'L3',
      },
    ],
  });

  it('treats tenor-only strip retimes as the same program', () => {
    const a = approvedStrip();
    const b = {
      ...a,
      legs: a.legs.map((l, i) => ({
        ...l,
        settleMonths: [4, 8, 12][i]!,
        endMonth: [4, 8, 12][i]!,
      })),
    };
    expect(sameHedgeProgramExecution(a, b)).toBe(true);
  });

  it('keeps approved when Cash Carry restages the same clip with new points', () => {
    const prev = { EUR: approvedStrip() };
    const retimed = {
      ...approvedStrip(),
      approvalStatus: 'draft' as const,
      approvalWho: undefined,
      legs: approvedStrip().legs.map((l, i) => ({
        ...l,
        settleMonths: [4, 8, 12][i]!,
        endMonth: [4, 8, 12][i]!,
      })),
    };
    const next = setPreparedHedgeForCcy(prev, 'EUR', retimed);
    expect(next.EUR?.approvalStatus).toBe('approved');
    expect(next.EUR?.approvalWho).toBe('Treasury');
    expect(next.EUR?.legs.map(l => l.settleMonths)).toEqual([4, 8, 12]);
  });

  it('returns to draft when total notional or direction changes', () => {
    const prev = { EUR: approvedStrip() };
    const bigger = setPreparedHedgeForCcy(prev, 'EUR', {
      ...approvedStrip(),
      coverLocalM: 14.65,
      approvalStatus: 'draft',
    });
    expect(bigger.EUR?.approvalStatus).toBe('draft');

    const flipped = setPreparedHedgeForCcy(prev, 'EUR', {
      ...approvedStrip(),
      coverLocalM: -6.35,
      approvalStatus: 'draft',
    });
    expect(flipped.EUR?.approvalStatus).toBe('draft');
  });

  it('lets Hedging Decision restage a new clip as already approved', () => {
    const prev = { EUR: approvedStrip() };
    const next = setPreparedHedgeForCcy(prev, 'EUR', {
      ...approvedStrip(),
      coverLocalM: 5.1,
      approvalStatus: 'approved',
    });
    expect(next.EUR?.approvalStatus).toBe('approved');
    expect(next.EUR?.coverLocalM).toBeCloseTo(5.1);
  });

  it('keeps a Cash Carry strip live when mix restages a same-clip bullet', () => {
    const strip = approvedStrip();
    const paired = attachPreparedPackages(strip, {
      strip,
      bullet: { ...stubProfile(), coverLocalM: 6.35, structure: 'bullet' },
    });
    const next = setPreparedHedgeForCcy(
      { EUR: { ...paired, approvalStatus: 'approved', preparedFor: 'carry' } },
      'EUR',
      {
        ...stubProfile(),
        structure: 'bullet',
        preparedFor: 'var',
        coverLocalM: 6.35,
        hedgeRatio: 1,
        approvalStatus: 'draft',
      },
    );
    expect(next.EUR?.structure).toBe('strip');
    expect(next.EUR?.legs).toHaveLength(3);
    expect(next.EUR?.approvalStatus).toBe('approved');
    expect(livePreparedHedge(next.EUR)?.structure).toBe('strip');
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

  it('retargets a Cash Carry 100% bullet to the mix leftover when preserveStrips is set', () => {
    const next = stageAtlasMixPrepared(
      {
        JPY: {
          ...stubProfile(),
          preparedFor: 'carry',
          coverLocalM: -1862.32,
          hedgeRatio: 1,
        },
      },
      [
        { ccy: 'JPY', weight: 0.16, coverLocalM: -293.12, lockedCarryUsdM: -0.016 },
      ],
      12,
      { preserveStrips: true },
    );
    expect(next.JPY?.preparedFor).toBe('carry');
    expect(next.JPY?.structure).toBe('bullet');
    expect(next.JPY?.coverLocalM).toBeCloseTo(-293.12);
    expect(next.JPY?.hedgeRatio).toBeCloseTo(0.16);
  });

  it('keeps a Cash Carry optimized strip when preserveStrips is set', () => {
    const strip: PreparedHedgeProfile = {
      ...stubProfile(0.044),
      structure: 'strip',
      preparedFor: 'carry',
      basis: 'cash',
      coverLocalM: 2.55,
      hedgeRatio: 1,
      legs: [
        {
          index: 0,
          startMonth: 0,
          endMonth: 3,
          settleMonths: 3,
          hedgeLocalM: 0.85,
          tradeNotionalLocalM: 0.85,
          label: 'L1',
        },
        {
          index: 1,
          startMonth: 0,
          endMonth: 6,
          settleMonths: 6,
          hedgeLocalM: 1.7,
          tradeNotionalLocalM: 0.85,
          label: 'L2',
        },
        {
          index: 2,
          startMonth: 0,
          endMonth: 12,
          settleMonths: 12,
          hedgeLocalM: 2.55,
          tradeNotionalLocalM: 0.85,
          label: 'L3',
        },
      ],
    };
    const next = stageAtlasMixPrepared(
      { EUR: strip },
      [
        { ccy: 'EUR', weight: 1, coverLocalM: 2.55, lockedCarryUsdM: 0.044 },
        { ccy: 'JPY', weight: 0, coverLocalM: 0, lockedCarryUsdM: 0 },
      ],
      12,
      { preserveStrips: true },
    );
    expect(next.EUR?.structure).toBe('strip');
    expect(next.EUR?.preparedFor).toBe('carry');
    expect(next.EUR?.legs).toHaveLength(3);
    expect(next.EUR?.settleMonths).toBeUndefined();
    expect(stripScheduleEndsFromPrepared(next.EUR)).toEqual([3, 6, 12]);
    const weights = stripScheduleWeightsFromPrepared(next.EUR);
    expect(weights).toHaveLength(3);
    expect(weights!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(weights![0]).toBeCloseTo(1 / 3, 10);
    expect(next.JPY).toBeUndefined();
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
    expect(next.EUR?.coverLocalM).toBeCloseTo(12.1);
    expect(next.EUR?.hedgeRatio).toBe(1);
    expect(next.EUR?.impliedCarryUsdM).toBeCloseTo(0.21);
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

describe('forecast → pending hedge', () => {
  it('accrues S + Σ flows as the gross Target N', () => {
    expect(grossForecastTargetLocalM(14, 12, [0.05, 0.05, 0.05], 0.05)).toBeCloseTo(
      14.15,
      5,
    );
    expect(grossForecastTargetLocalM(14, 2, undefined, 0.5)).toBeCloseTo(15, 5);
  });

  it('pending clip uses sticky mix % on the new forecast, not a lagged cover', () => {
    expect(pendingHedgeCoverLocalM(26.75, 0, 1)).toBeCloseTo(26.75);
    expect(pendingHedgeCoverLocalM(26.75, 12.1, 1)).toBeCloseTo(14.65);
    expect(pendingHedgeCoverLocalM(26.75, -12.1, 1)).toBeCloseTo(14.65);
    expect(pendingHedgeCoverLocalM(26.75, 0, 0.16)).toBeCloseTo(4.28);
  });

  it('treats a pending / approved package as committed cover', () => {
    const approved = {
      approvalStatus: 'approved' as const,
      preparedFor: 'var' as const,
      coverLocalM: 12.1,
    };
    const pending = { ...approved, approvalStatus: 'pending' as const };
    const draft = { ...approved, approvalStatus: 'draft' as const };
    expect(bookableHedgeCoverLocalM(12.1, 0, 1, approved)).toBeCloseTo(0);
    expect(bookableHedgeCoverLocalM(12.1, 0, 1, pending)).toBeCloseTo(0);
    expect(bookableHedgeCoverLocalM(12.1, 0, 1, draft)).toBeCloseTo(12.1);
    expect(bookableHedgeCoverLocalM(26.75, 0, 1, approved)).toBeCloseTo(14.65);
    expect(
      preparedTicketCoverLocalM(
        { coverLocalM: 12.1, hedgeRatio: 1 },
        12.1,
        0,
      ),
    ).toBeCloseTo(12.1);
    const kept = stageAtlasMixPrepared(
      {
        EUR: {
          ...stubProfile(0.12),
          approvalStatus: 'approved',
          coverLocalM: 12.1,
          hedgeRatio: 1,
        },
      },
      [{ ccy: 'EUR', weight: 1, coverLocalM: 0, lockedCarryUsdM: 0 }],
      12,
    );
    expect(kept.EUR?.approvalStatus).toBe('approved');
    expect(kept.EUR?.coverLocalM).toBeCloseTo(12.1);
  });

  it('does not unlock a bookable clip on a fully covered default forecast', () => {
    expect(pendingHedgeCoverLocalM(0, 12.1, 1)).toBeCloseTo(0);
    expect(pendingHedgeCoverLocalM(0, -12.1, 1)).toBeCloseTo(0);
    expect(bookableHedgeCoverLocalM(12.1, 12.1, 1)).toBeCloseTo(0);
    expect(bookableHedgeCoverLocalM(12.1, -12.1, 1)).toBeCloseTo(0);
    expect(bookableHedgeCoverLocalM(12.1, 12.104, 1)).toBeCloseTo(0);
    expect(bookableHedgeCoverLocalM(12.1, 12.096, 1)).toBeCloseTo(0);
    expect(bookableHedgeCoverLocalM(26.75, 12.1, 1)).toBeCloseTo(14.65);
    expect(bookableHedgeCoverLocalM(8, 12.1, 1)).toBeCloseTo(-4.1);
    expect(
      preparedTicketCoverLocalM(
        { coverLocalM: 14.65, hedgeRatio: 1 },
        12.1,
        12.1,
      ),
    ).toBeCloseTo(0);
  });

  it('a mix package sized to full Target books only the unbooked clip', () => {
    expect(
      preparedTicketCoverLocalM(
        { coverLocalM: 26.75, hedgeRatio: 1 },
        26.75,
        12.1,
      ),
    ).toBeCloseTo(14.65);
    expect(
      preparedTicketCoverLocalM(
        { coverLocalM: 26.75, hedgeRatio: 1 },
        26.75,
        -12.1,
      ),
    ).toBeCloseTo(14.65);
  });

  it('Approve Incremental is leftover vs blotter, even when the package is already approved', () => {
    const eurApproved = {
      coverLocalM: 2.55,
      hedgeRatio: 1,
      approvalStatus: 'approved' as const,
      preparedFor: 'var' as const,
    };
    // Book / canBook still treats the package as committed (no second ticket).
    expect(bookableHedgeCoverLocalM(14.65, 12.1, 1, eurApproved)).toBeCloseTo(0);
    // Approve table Incremental is the unbooked clip, not 0.
    expect(preparedTicketCoverLocalM(eurApproved, 14.65, 12.1)).toBeCloseTo(2.55);
    const gbpApproved = {
      coverLocalM: 5.08,
      hedgeRatio: 1,
      approvalStatus: 'approved' as const,
      preparedFor: 'var' as const,
    };
    expect(bookableHedgeCoverLocalM(5.08, 0, 1, gbpApproved)).toBeCloseTo(0);
    expect(preparedTicketCoverLocalM(gbpApproved, 5.08, 0)).toBeCloseTo(5.08);
  });

  it('prefers gross forecast over remaining Target for mix cover', () => {
    expect(
      mixCoverTargetLocalM({
        targetHedgeLocalM: 14.65,
        forecastTargetLocalM: 26.75,
      }),
    ).toBeCloseTo(26.75);
  });

  it('scales a staged strip with the forecast sizer, keeping leg shape', () => {
    const strip: PreparedHedgeProfile = {
      ...stubProfile(0.2),
      structure: 'strip',
      basis: 'totalExpected',
      preparedFor: 'var',
      coverLocalM: 12,
      hedgeRatio: 1,
      legs: [
        {
          index: 0,
          startMonth: 0,
          endMonth: 6,
          settleMonths: 6,
          hedgeLocalM: 4,
          tradeNotionalLocalM: 4,
          label: 'L1',
        },
        {
          index: 1,
          startMonth: 6,
          endMonth: 12,
          settleMonths: 12,
          hedgeLocalM: 12,
          tradeNotionalLocalM: 8,
          label: 'L2',
        },
      ],
    };
    const scaled = scalePreparedHedgeToCover(strip, { coverLocalM: 24 });
    expect(scaled.coverLocalM).toBeCloseTo(24);
    expect(scaled.legs[0]?.hedgeLocalM).toBeCloseTo(8);
    expect(scaled.legs[1]?.tradeNotionalLocalM).toBeCloseTo(16);

    const moved = scalePreparedHedgesBySizerMove(
      { EUR: strip },
      { EUR: { forecast: 12, stock: 10, varNeutral: 8 } },
      { EUR: { forecast: 24, stock: 10, varNeutral: 8 } },
    );
    expect(moved?.EUR?.coverLocalM).toBeCloseTo(24);
    expect(moved?.EUR?.legs[1]?.hedgeLocalM).toBeCloseTo(24);
  });

  it('retargets an FX Risk mix to w × new forecast − booked, not E_new/E_old of the old ticket', () => {
    const mix: PreparedHedgeProfile = {
      ...stubProfile(0.21),
      basis: 'totalExpected',
      preparedFor: 'var',
      coverLocalM: 12.1,
      hedgeRatio: 1,
    };
    const grown = scalePreparedHedgesBySizerMove(
      { EUR: mix },
      { EUR: { forecast: 12.1, stock: 14, varNeutral: 9, booked: 12.1 } },
      { EUR: { forecast: 26.75, stock: 14, varNeutral: 9, booked: 12.1 } },
    );
    expect(grown?.EUR?.coverLocalM).toBeCloseTo(14.65);
    expect(grown?.EUR?.hedgeRatio).toBeCloseTo(1);

    const open = scalePreparedHedgesBySizerMove(
      { EUR: { ...mix, coverLocalM: 12.1 } },
      { EUR: { forecast: 12.1, stock: 14, varNeutral: 9, booked: 0 } },
      { EUR: { forecast: 26.75, stock: 14, varNeutral: 9, booked: 0 } },
    );
    expect(open?.EUR?.coverLocalM).toBeCloseTo(26.75);

    const partial = scalePreparedHedgesBySizerMove(
      { EUR: { ...mix, coverLocalM: 16, hedgeRatio: 0.16 } },
      { EUR: { forecast: 100, stock: 80, varNeutral: 50, booked: 0 } },
      { EUR: { forecast: 200, stock: 80, varNeutral: 50, booked: 0 } },
    );
    expect(partial?.EUR?.coverLocalM).toBeCloseTo(32);

    const covered = scalePreparedHedgesBySizerMove(
      { EUR: mix },
      { EUR: { forecast: 26.75, stock: 14, varNeutral: 9, booked: 12.1 } },
      { EUR: { forecast: 12.1, stock: 14, varNeutral: 9, booked: 12.1 } },
    );
    expect(covered?.EUR).toBeUndefined();
  });

  it('does not rescale a liquidity overlay when the forecast sizer moves', () => {
    const overlay: PreparedHedgeProfile = {
      ...stubProfile(0.05),
      preparedFor: 'liquidity',
      basis: 'totalExpected',
      coverLocalM: 8,
    };
    const moved = scalePreparedHedgesBySizerMove(
      { EUR: overlay },
      { EUR: { forecast: 12, stock: 10, varNeutral: 8 } },
      { EUR: { forecast: 24, stock: 10, varNeutral: 8 } },
    );
    expect(moved).toBeNull();
  });
});


describe('prepared structure packages', () => {
  const strip: PreparedHedgeProfile = {
    ...stubProfile(0.12),
    structure: 'strip',
    coverLocalM: 12,
    settleMonths: undefined,
    legs: [
      {
        index: 0,
        startMonth: 0,
        endMonth: 3,
        settleMonths: 3,
        hedgeLocalM: 4,
        tradeNotionalLocalM: 4,
        label: 'L1',
      },
      {
        index: 1,
        startMonth: 3,
        endMonth: 12,
        settleMonths: 12,
        hedgeLocalM: 12,
        tradeNotionalLocalM: 8,
        label: 'L2',
      },
    ],
  };
  const bullet: PreparedHedgeProfile = {
    ...stubProfile(0.09),
    structure: 'bullet',
    coverLocalM: 12,
    settleMonths: 9,
    legs: [],
  };

  it('keeps both Cash Carry structures on the staged package', () => {
    const staged = attachPreparedPackages(strip, { bullet, strip });
    expect(staged.structure).toBe('strip');
    expect(staged.packages?.bullet?.settleMonths).toBe(9);
    expect(staged.packages?.strip?.legs).toHaveLength(2);
    expect(packageForStructure(staged, 'bullet')?.settleMonths).toBe(9);
    expect(packageForStructure(staged, 'strip')?.legs).toHaveLength(2);
  });

  it('does not drop a prior strip when restaging a bullet', () => {
    const first = setPreparedHedgeForCcy({}, 'EUR', strip);
    const next = setPreparedHedgeForCcy(first, 'EUR', bullet);
    expect(next.EUR?.structure).toBe('bullet');
    expect(next.EUR?.packages?.strip?.legs).toHaveLength(2);
    expect(packageForStructure(next.EUR, 'strip')?.coverLocalM).toBe(12);
  });

  it('keeps ranked Cash Carry ladders when restaging a strip without them', () => {
    const stripChoices: StagedStripChoice[] = [
      {
        structure: 'strip',
        legCount: 2,
        centerOfMass: 0.4,
        kurtosis: 1.1,
        settleScheduleLabel: '3M / 12M',
        settleMonths: [3, 12],
        legs: [
          { settleMonths: 3, amountLocalM: 4, label: 'L1' },
          { settleMonths: 12, amountLocalM: 8, label: 'L2' },
        ],
        hedgeDeltaLocalM: 12,
        enhancementUsdM: 0.01,
        newCarryUsdM: 0.04,
        fwdCarryUsdM: 0.05,
        vsBulletUsdM: 0.02,
      },
      {
        structure: 'strip',
        legCount: 3,
        centerOfMass: 0.55,
        kurtosis: 0.8,
        settleScheduleLabel: '3M / 6M / 12M',
        settleMonths: [3, 6, 12],
        legs: [
          { settleMonths: 3, amountLocalM: 3.5, label: 'L1' },
          { settleMonths: 6, amountLocalM: 5.5, label: 'L2' },
          { settleMonths: 12, amountLocalM: 7.3, label: 'L3' },
        ],
        hedgeDeltaLocalM: 16.3,
        enhancementUsdM: 0.02,
        newCarryUsdM: 0.05,
        fwdCarryUsdM: 0.06,
        vsBulletUsdM: 0.03,
      },
    ];
    const first = setPreparedHedgeForCcy({}, 'EUR', { ...strip, stripChoices });
    const restaged: PreparedHedgeProfile = {
      ...strip,
      coverLocalM: 16.3,
      legs: [
        {
          index: 0,
          startMonth: 0,
          endMonth: 3.5,
          settleMonths: 3.5,
          hedgeLocalM: 3.5,
          tradeNotionalLocalM: 3.5,
          label: 'L1',
        },
        {
          index: 1,
          startMonth: 3.5,
          endMonth: 5.5,
          settleMonths: 5.5,
          hedgeLocalM: 9,
          tradeNotionalLocalM: 5.5,
          label: 'L2',
        },
        {
          index: 2,
          startMonth: 5.5,
          endMonth: 7.3,
          settleMonths: 7.3,
          hedgeLocalM: 16.3,
          tradeNotionalLocalM: 7.3,
          label: 'L3',
        },
      ],
    };
    const next = setPreparedHedgeForCcy(first, 'EUR', restaged);
    expect(next.EUR?.coverLocalM).toBe(16.3);
    expect(next.EUR?.legs).toHaveLength(3);
    expect(next.EUR?.stripChoices).toHaveLength(2);
    expect(next.EUR?.stripChoices?.[1]?.settleScheduleLabel).toBe(
      '3M / 6M / 12M',
    );
    expect(packageForStructure(next.EUR, 'strip')?.stripChoices).toHaveLength(2);
  });

  it('derives a WAM bullet from a strip when no sibling was staged', () => {
    const pkg = packageForStructure(strip, 'bullet');
    expect(pkg?.structure).toBe('bullet');
    expect(pkg?.legs).toHaveLength(0);
    expect(pkg?.settleMonths).toBeCloseTo((4 * 3 + 8 * 12) / 12);
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

function stubTicket(partial: Partial<HedgeTicket> & Pick<HedgeTicket, 'id'>): HedgeTicket {
  return {
    ccy: 'EUR',
    instrument: 'forward',
    basis: 'totalBuildup',
    amountLocalM: 0,
    maturity: '6m',
    maturityLabel: '6M',
    varUsdM: 0.1,
    addressesHigherVar: true,
    status: 'booked',
    ...partial,
  };
}

describe('stripFullyExecuted', () => {
  /** `n` cover legs on one strip, the first `filledCount` of them executed. */
  const ladder = (n: number, filledCount: number): HedgeTicket[] =>
    Array.from({ length: n }, (_, i) =>
      stubTicket({
        id: `l${i}`,
        stripId: 'sp',
        stripEdgeIndex: i,
        amountLocalM: 2.02,
        maturityMonths: (i + 1) * 2,
        ...(i < filledCount
          ? {
              status: 'booked' as const,
              filledAtMs: 1_789_000_000_000 + i,
              orderHit: 'bid' as const,
            }
          : { status: 'scheduled' as const, limitRate: 1.16 }),
      }),
    );

  it('reports a strip whose every edge executed as finished', () => {
    // The reported defect: a new booking opened with every leg already
    // showing as executed, inherited from the previous hedge. Once the old
    // strip is finished the next Book must start from a clean sheet.
    expect(stripFullyExecuted(ladder(6, 6))).toBe(true);
  });

  it('does not report a part-worked strip as finished', () => {
    // Three slots still to fill — Book is how the desk fills them, so those
    // peers must keep coming through.
    expect(stripFullyExecuted(ladder(6, 3))).toBe(false);
  });

  it('does not report a strip with a working bracket as finished', () => {
    const tickets = [
      ...ladder(2, 2),
      stubTicket({
        id: 'tp',
        stripId: 'sp',
        stripEdgeIndex: 1,
        bracketRole: 'takeProfit',
        status: 'scheduled',
        limitRate: 1.18,
      }),
    ];
    expect(stripFullyExecuted(tickets)).toBe(false);
  });

  it('does not report an empty or fully cancelled strip as finished', () => {
    expect(stripFullyExecuted([])).toBe(false);
    const cancelled = ladder(3, 3).map(t => ({
      ...t,
      status: 'cancelled' as const,
    }));
    expect(stripFullyExecuted(cancelled)).toBe(false);
  });
});

describe('stripExecutionStarted', () => {
  it('is false with no tickets or only cancelled ones', () => {
    expect(stripExecutionStarted([])).toBe(false);
    expect(
      stripExecutionStarted([
        stubTicket({ id: 'c', stripId: 'sp', status: 'cancelled' }),
      ]),
    ).toBe(false);
  });

  it('is true once a cover is filled or an order is left working', () => {
    expect(
      stripExecutionStarted([
        stubTicket({
          id: 'fill',
          stripId: 'sp',
          stripEdgeIndex: 0,
          filledAtMs: 1,
        }),
      ]),
    ).toBe(true);
    expect(
      stripExecutionStarted([
        stubTicket({
          id: 'rest',
          stripId: 'sp',
          stripEdgeIndex: 1,
          status: 'scheduled',
          limitRate: 1.16,
        }),
      ]),
    ).toBe(true);
  });
});

describe('legPeersAtEdge', () => {
  it('never reports a bracket fill as the leg\'s own fill', () => {
    // A spot TP filling at this edge is a separate order, not the cover
    // leg trading. Treating it as the leg's fill printed its SPOT price
    // under the leg's FORWARD label and sized the row off the bracket.
    const peers = [
      stubTicket({
        id: 'tp',
        bracketRole: 'takeProfit',
        instrument: 'spot',
        amountLocalM: 2.7,
        limitRate: 1.163,
        stripId: 's',
        stripEdgeIndex: 0,
        filledAtMs: 1_800_000_000_000,
      }),
    ];
    expect(legPeersAtEdge(peers, 0, { coverOnly: true }).filled).toBeUndefined();
    // Consumers that report the edge's execution as such still see it.
    expect(legPeersAtEdge(peers, 0).filled?.id).toBe('tp');

    const withCover = [
      ...peers,
      stubTicket({
        id: 'cover',
        amountLocalM: 4.05,
        stripId: 's',
        stripEdgeIndex: 0,
        filledAtMs: 1_800_000_050_000,
      }),
    ];
    expect(legPeersAtEdge(withCover, 0, { coverOnly: true }).filled?.id).toBe(
      'cover',
    );
  });

  it('reports a spot-referenced bracket fill as the leg\'s own fill', () => {
    // It booked the leg's own M12 forward at spot + points, so the leg row
    // shows that fill (and its TP type) instead of looking unfilled.
    const tp = stubTicket({
      id: 'sr-tp',
      bracketRole: 'takeProfit',
      instrument: 'forward',
      isSpotReferenced: true,
      stripLegPoints: 170.1,
      maturity: '1y',
      maturityMonths: 12,
      amountLocalM: 4.05,
      limitRate: 1.16,
      stripId: 's',
      stripEdgeIndex: 4,
      filledAtMs: 1_800_000_000_000,
    });
    expect(legPeersAtEdge([tp], 4, { coverOnly: true }).filled?.id).toBe('sr-tp');
    // A cover leg that traded still wins over it.
    const cover = stubTicket({
      id: 'cover-m12',
      amountLocalM: 4.05,
      stripId: 's',
      stripEdgeIndex: 4,
      filledAtMs: 1_800_000_050_000,
    });
    expect(legPeersAtEdge([tp, cover], 4, { coverOnly: true }).filled?.id).toBe(
      'cover-m12',
    );
  });
});

describe('session pending hedge after a strip fill', () => {
  it('drops the executed leg from outstanding so remaining spot/fwd/option size off it', () => {
    const program = 12.1;
    const filled = stubTicket({
      id: 'l1',
      amountLocalM: 2.2,
      stripId: 's1',
      stripEdgeIndex: 0,
      status: 'booked',
      filledAtMs: 1_700_000_000_000,
    });
    expect(sessionExecutedCoverAbs([filled])).toBeCloseTo(2.2);
    expect(sessionPendingHedgeAbs(program, [filled])).toBeCloseTo(9.9);
    expect(sessionPendingHedgeAbs(program, [])).toBeCloseTo(12.1);
  });

  it('ignores TP/SL and counts each strip edge once', () => {
    const cover = stubTicket({
      id: 'l1',
      amountLocalM: 2.2,
      stripId: 's1',
      stripEdgeIndex: 0,
      status: 'booked',
      filledAtMs: 1,
    });
    const dup = stubTicket({
      id: 'l1-dup',
      amountLocalM: 2.2,
      stripId: 's1',
      stripEdgeIndex: 0,
      status: 'booked',
      filledAtMs: 2,
    });
    const tp = stubTicket({
      id: 'l1-tp',
      amountLocalM: 2.2,
      stripId: 's1',
      stripEdgeIndex: 0,
      status: 'scheduled',
      bracketRole: 'takeProfit',
      limitRate: 1.18,
    });
    expect(sessionExecutedCoverAbs([cover, dup, tp])).toBeCloseTo(2.2);
    expect(sessionPendingHedgeAbs(12.1, [cover, dup, tp])).toBeCloseTo(9.9);
  });

  it('does not subtract fills already netted out of a Book compose leftover', () => {
    const openedAt = 1_700_000_100_000;
    const filled = stubTicket({
      id: 'l1',
      amountLocalM: 2.2,
      stripId: 's1',
      stripEdgeIndex: 0,
      status: 'booked',
      filledAtMs: 1_700_000_000_000,
    });
    // snap.trade is already 9.9 after the 2.2 fill. Subtracting 2.2 again
    // used to open the modal at 0.00 outstanding.
    expect(
      sessionPendingHedgeAbs(9.9, [filled], { programNettedAtMs: openedAt }),
    ).toBeCloseTo(9.9);
    const laterFill = stubTicket({
      id: 'l2',
      amountLocalM: 1.1,
      stripId: 's1',
      stripEdgeIndex: 1,
      status: 'booked',
      filledAtMs: openedAt + 5_000,
    });
    expect(
      sessionPendingHedgeAbs(9.9, [filled, laterFill], {
        programNettedAtMs: openedAt,
      }),
    ).toBeCloseTo(8.8);
  });
});

describe('sessionStripClipAbs', () => {
  const legs = [0.73, 0.41, 0.46, 0.68];

  it('keeps unfilled legs outstanding even when one ticket booked the whole program', () => {
    const fatFill = stubTicket({
      id: 'l1',
      amountLocalM: 9.82,
      stripId: 's1',
      stripEdgeIndex: 0,
      status: 'booked',
      filledAtMs: 1,
    });
    const clip = sessionStripClipAbs(legs, [fatFill]);
    expect(clip.executedAbs).toBeCloseTo(0.73);
    expect(clip.pendingAbs).toBeCloseTo(0.41 + 0.46 + 0.68);
  });

  it('sizes remaining spot/fwd/option off free legs after a partial strip fill', () => {
    const l1 = stubTicket({
      id: 'l1',
      amountLocalM: 0.73,
      stripId: 's1',
      stripEdgeIndex: 0,
      status: 'booked',
      filledAtMs: 1,
    });
    const l2 = stubTicket({
      id: 'l2',
      amountLocalM: 0.41,
      stripId: 's1',
      stripEdgeIndex: 1,
      status: 'booked',
      filledAtMs: 2,
    });
    const clip = sessionStripClipAbs(legs, [l1, l2]);
    expect(clip.executedAbs).toBeCloseTo(1.14);
    expect(clip.pendingAbs).toBeCloseTo(1.14);
  });

  it('treats a working order as spent so leftover trades as option/spot', () => {
    const working = stubTicket({
      id: 'l1',
      amountLocalM: 0.73,
      stripId: 's1',
      stripEdgeIndex: 0,
      status: 'scheduled',
      limitRate: 1.15,
    });
    const clip = sessionStripClipAbs(legs, [working]);
    expect(clip.executedAbs).toBeCloseTo(0.73);
    expect(clip.pendingAbs).toBeCloseTo(0.41 + 0.46 + 0.68);
  });

  it('does not resurrect a cancelled leg as outstanding', () => {
    const cancelled = stubTicket({
      id: 'l3',
      amountLocalM: 0.46,
      stripId: 's1',
      stripEdgeIndex: 2,
      status: 'cancelled',
    });
    const l1 = stubTicket({
      id: 'l1',
      amountLocalM: 0.73,
      stripId: 's1',
      stripEdgeIndex: 0,
      status: 'booked',
      filledAtMs: 1,
    });
    const clip = sessionStripClipAbs(legs, [l1, cancelled]);
    expect(clip.executedAbs).toBeCloseTo(0.73);
    expect(clip.pendingAbs).toBeCloseTo(0.41 + 0.68);
  });
});

describe('bookedStripResumeSeed', () => {
  const partWorked = [
    stubTicket({
      id: 'l1',
      stripId: 'old',
      stripEdgeIndex: 0,
      amountLocalM: 3.09,
      status: 'booked',
      filledAtMs: 1_000,
    }),
    stubTicket({
      id: 'l2',
      stripId: 'old',
      stripEdgeIndex: 1,
      amountLocalM: 2.21,
      status: 'scheduled',
      limitRate: 1.16,
    }),
  ];

  it('resumes a part-worked strip even when Book minted a new stripId', () => {
    expect(bookedStripResumeSeed('strip-EUR-fresh', partWorked)?.stripId).toBe(
      'old',
    );
  });

  it('does not pull a live strip onto a bullet Book compose', () => {
    expect(bookedStripResumeSeed(undefined, partWorked)).toBeUndefined();
  });

  it('prefers the ticket’s own strip when that id is on the book', () => {
    expect(bookedStripResumeSeed('old', partWorked)?.id).toBe('l1');
  });

  const finished = [
    partWorked[0]!,
    stubTicket({
      id: 'l2',
      stripId: 'old',
      stripEdgeIndex: 1,
      amountLocalM: 2.21,
      status: 'booked',
      filledAtMs: 5_000,
    }),
  ];

  it('keeps resuming a strip whose last leg filled while the overlay was open', () => {
    expect(bookedStripResumeSeed('strip-EUR-fresh', finished, 4_000)?.stripId).toBe(
      'old',
    );
  });

  it('treats a strip finished before the overlay opened as a clean sheet', () => {
    expect(bookedStripResumeSeed('strip-EUR-fresh', finished, 6_000)).toBeUndefined();
    expect(bookedStripResumeSeed('strip-EUR-fresh', finished)).toBeUndefined();
  });

  it('does not resume a strip finished before opening just because a leftover leg filled since', () => {
    const leftover = stubTicket({
      id: 'l3',
      stripId: 'old',
      stripEdgeIndex: 2,
      amountLocalM: 1.5,
      status: 'booked',
      filledAtMs: 9_000,
    });
    expect(
      bookedStripResumeSeed('strip-EUR-fresh', [...finished, leftover], 6_000),
    ).toBeUndefined();
  });
});

describe('resumePartWorkedStripOnBook', () => {
  const fiveLeg: PreparedHedgeProfile = {
    structure: 'strip',
    basis: 'varNeutral',
    ticketBasis: 'simpleAvg',
    coverLocalM: 12,
    hedgeRatio: 1,
    legs: [2.4, 4.8, 7.2, 9.6, 12].map((settle, i) => ({
      index: i,
      startMonth: 0,
      endMonth: settle,
      settleMonths: settle,
      hedgeLocalM: (i + 1) * 2.4,
      tradeNotionalLocalM: 2.4,
      label: `L${i + 1}`,
    })),
  };
  const sixLeg: PreparedHedgeProfile = {
    ...fiveLeg,
    coverLocalM: 12.1,
    legs: [2, 4, 6, 8, 10, 12].map((settle, i) => ({
      index: i,
      startMonth: 0,
      endMonth: settle,
      settleMonths: settle,
      hedgeLocalM: (i + 1) * 2,
      tradeNotionalLocalM: 2,
      label: `M0–M${settle}`,
    })),
  };

  it('does not resume a 5-leg fill stamp over a new 6-leg remaining program', () => {
    expect(stripSchedulesAgree(fiveLeg, sixLeg)).toBe(false);
    expect(
      resumePartWorkedStripOnBook({
        bookedStamp: fiveLeg,
        staged: sixLeg,
      }),
    ).toBe(false);
  });

  it('still resumes when Analytics kept the same settle ladder', () => {
    expect(
      resumePartWorkedStripOnBook({
        bookedStamp: fiveLeg,
        staged: { ...fiveLeg, coverLocalM: 8.65 },
      }),
    ).toBe(true);
  });

  it('resumes the live strip when nothing new is staged', () => {
    expect(
      resumePartWorkedStripOnBook({
        bookedStamp: fiveLeg,
        staged: undefined,
      }),
    ).toBe(true);
  });
});

describe('sessionBookOverlayClipAbs', () => {
  it('keeps remaining intact legs as the clip instead of a new leftover booking', () => {
    const openedAt = 2_000;
    const l1 = stubTicket({
      id: 'l1',
      amountLocalM: 3.09,
      stripId: 's1',
      stripEdgeIndex: 0,
      status: 'booked',
      filledAtMs: 1_000,
    });
    // Original remaining rows sum to leftover 9.68. Leftover-scaling the
    // whole ladder then greying L1 again would leave only 6.59.
    const stripClip = sessionStripClipAbs([3.09, 2.21, 2.21, 5.26], [l1]);
    expect(stripClip.pendingAbs).toBeCloseTo(9.68);
    expect(stripClip.executedAbs).toBeCloseTo(3.09);
    const overlay = sessionBookOverlayClipAbs({
      programLocalM: 9.68,
      tickets: [l1],
      bookSession: true,
      openedAtMs: openedAt,
      stripClip,
    });
    expect(overlay.pendingAbs).toBeCloseTo(9.68);
    expect(overlay.executedAbs).toBeCloseTo(3.09);
  });

  it('still drops a fill that happens after Book opened when there is no strip', () => {
    const openedAt = 2_000;
    const later = stubTicket({
      id: 'new-l1',
      amountLocalM: 3.09,
      stripId: 's',
      stripEdgeIndex: 0,
      status: 'booked',
      filledAtMs: 2_500,
    });
    const overlay = sessionBookOverlayClipAbs({
      programLocalM: 9.68,
      tickets: [later],
      bookSession: true,
      openedAtMs: openedAt,
    });
    expect(overlay.pendingAbs).toBeCloseTo(6.59);
    expect(overlay.executedAbs).toBeCloseTo(3.09);
  });
});

describe('committed hedge budget', () => {
  it('does not let a BUY option cancel SELL forwards in the budget', () => {
    const tickets = [
      stubTicket({ id: 's1', amountLocalM: 2.55 }),
      stubTicket({ id: 's2', amountLocalM: 2.55 }),
      stubTicket({
        id: 'opt',
        instrument: 'option',
        amountLocalM: -12.1,
      }),
    ];
    expect(committedHedgeNotionalLocalM(tickets, 'EUR')).toBeCloseTo(17.2);
    expect(bookableAddHedgeCoverLocalM(12.1, 17.2, 1)).toBe(0);
  });

  it('counts an OCO take-profit / stop-loss pair once', () => {
    const tickets = [
      stubTicket({
        id: 'tp',
        amountLocalM: 5.1,
        status: 'scheduled',
        bracketRole: 'takeProfit',
        ocoGroupId: 'oco-1',
      }),
      stubTicket({
        id: 'sl',
        amountLocalM: 5.1,
        status: 'scheduled',
        bracketRole: 'stopLoss',
        ocoGroupId: 'oco-1',
      }),
      stubTicket({
        id: 'lim',
        amountLocalM: 2.55,
        status: 'scheduled',
      }),
    ];
    expect(committedHedgeNotionalLocalM(tickets, 'EUR')).toBeCloseTo(7.65);
  });

  it('includes working strip legs in the budget', () => {
    const tickets = [
      stubTicket({
        id: 'l1',
        amountLocalM: 3.03,
        status: 'scheduled',
        stripId: 'strip-1',
      }),
      stubTicket({
        id: 'l2',
        amountLocalM: 3.32,
        status: 'scheduled',
        stripId: 'strip-1',
      }),
    ];
    expect(committedHedgeNotionalLocalM(tickets, 'EUR')).toBeCloseTo(6.35);
  });
});

describe('hedgeCoverSnapshot / Decision Book clip', () => {
  it('counts same-sign sells as covering and ignores a BUY option', () => {
    const tickets = [
      stubTicket({ id: 's1', amountLocalM: 5.1 }),
      stubTicket({
        id: 'opt',
        instrument: 'option',
        amountLocalM: -12.1,
      }),
    ];
    const snap = hedgeCoverSnapshot(tickets, 'EUR', 12.1, 1);
    expect(snap.covering).toBeCloseTo(5.1);
    expect(snap.committedGross).toBeCloseTo(17.2);
    expect(snap.residual).toBeCloseTo(7);
    expect(snap.unwind).toBe(0);
    expect(snap.trade).toBe(0);
  });

  it('splits filled vs pending settlement covering', () => {
    const tickets = [
      stubTicket({ id: 'fill', amountLocalM: 10 }),
      stubTicket({ id: 'work', amountLocalM: 4.65, status: 'scheduled' }),
    ];
    const split = coveringHedgeSplitLocalM(tickets, 'EUR', 14.65);
    expect(split.existing).toBeCloseTo(10);
    expect(split.pending).toBeCloseTo(4.65);
    expect(split.covering).toBeCloseTo(14.65);
  });

  it('proposes a buy-back when covering exceeds the forecast', () => {
    const tickets = [stubTicket({ id: 'strip', amountLocalM: 14.65 })];
    const snap = hedgeCoverSnapshot(tickets, 'EUR', 9.94, 1);
    expect(snap.unwind).toBeCloseTo(4.71);
    expect(snap.residual).toBeCloseTo(-4.71);
    expect(snap.trade).toBeCloseTo(-4.71);
    expect(snap.flattenTrade).toBeCloseTo(4.71);
  });

  it('still has a Book clip after an approved package (approval is not blotter cover)', () => {
    const snap = hedgeCoverSnapshot([], 'EUR', 14.65, 1);
    expect(snap.trade).toBeCloseTo(14.65);
  });
});

describe('composeDecisionBookTicket / Decision Book overlay', () => {
  const stripPrep: PreparedHedgeProfile = {
    structure: 'strip',
    basis: 'varNeutral',
    ticketBasis: 'simpleAvg',
    legs: [
      {
        index: 0,
        startMonth: 0,
        endMonth: 1.5,
        settleMonths: 1.5,
        hedgeLocalM: 2.2,
        tradeNotionalLocalM: 2.2,
        label: 'L1',
      },
      {
        index: 1,
        startMonth: 1.5,
        endMonth: 3,
        settleMonths: 3,
        hedgeLocalM: 4.4,
        tradeNotionalLocalM: 2.2,
        label: 'L2',
      },
    ],
    coverLocalM: 14.65,
    hedgeRatio: 1,
    preparedFor: 'var',
    approvalStatus: 'approved',
  };
  const filledTemplate = stubTicket({
    id: 'filled-strip-l1',
    amountLocalM: 2.2,
    stripId: 'strip-EUR-old',
    stripEdgeIndex: 0,
    status: 'booked',
    filledAtMs: 1_700_000_000_000,
    orderHit: 'bid',
    counterparty: 'CITI',
  });

  it('unwind beside a live strip is a free bullet, not the filled strip', () => {
    expect(
      decisionBookOpenStructure({
        isUnwind: true,
        liveStripOnBook: true,
        prepared: stripPrep,
      }),
    ).toBe('bullet');
    const ticket = composeDecisionBookTicket({
      template: filledTemplate,
      amountLocalM: -4.71,
      isUnwind: true,
      liveStripOnBook: true,
      prepared: stripPrep,
      maturity: '1y',
      maturityLabel: '12M · bullet Tf',
      varUsdM: 0.2,
    });
    expect(ticket.id).not.toBe(filledTemplate.id);
    expect(ticket.stripId).toBeUndefined();
    expect(ticket.status).toBeUndefined();
    expect(ticket.filledAtMs).toBeUndefined();
    expect(ticket.orderHit).toBeUndefined();
    expect(ticket.sourcePackage?.structure).toBe('bullet');
    expect(ticket.sourcePackage?.legs).toEqual([]);
    expect(ticket.amountLocalM).toBeCloseTo(-4.71);
  });

  it('leftover add beside a live strip is a free bullet, not the old 8-leg ladder', () => {
    expect(
      decisionBookOpenStructure({
        isUnwind: false,
        liveStripOnBook: true,
        prepared: stripPrep,
      }),
    ).toBe('bullet');
    const ticket = composeDecisionBookTicket({
      template: filledTemplate,
      amountLocalM: 2.55,
      isUnwind: false,
      liveStripOnBook: true,
      prepared: stripPrep,
      maturity: '1y',
      maturityLabel: '12M · bullet Tf',
      varUsdM: 0.2,
    });
    expect(ticket.stripId).toBeUndefined();
    expect(ticket.filledAtMs).toBeUndefined();
    expect(ticket.sourcePackage?.structure).toBe('bullet');
    expect(ticket.sourcePackage?.legs).toEqual([]);
    expect(ticket.amountLocalM).toBeCloseTo(2.55);
  });

  it('mints no second strip when the card sends an explicit bullet beside a live one', () => {
    // The card used to pass its own toggle through as `structure`, which
    // overrides decisionBookOpenStructure entirely — so a card sitting on
    // Strip composed a SECOND strip for a currency that already had one.
    // The book cannot hold that: the slot key carries no stripId, so the new
    // legs are dropped on merge, and the modal showed the old strip's
    // executed legs under the new ladder's tenors. The card now resolves
    // 'bullet' itself when a strip is live, and this is that call.
    const ticket = composeDecisionBookTicket({
      template: filledTemplate,
      amountLocalM: 2.55,
      isUnwind: false,
      liveStripOnBook: true,
      prepared: stripPrep,
      structure: 'bullet',
      maturity: '1y',
      maturityLabel: '12M · bullet Tf',
      varUsdM: 0.2,
    });
    expect(ticket.stripId).toBeUndefined();
    expect(ticket.sourcePackage?.structure).toBe('bullet');
    expect(ticket.sourcePackage?.legs).toEqual([]);
    expect(ticket.amountLocalM).toBeCloseTo(2.55);
  });

  it('still mints a strip when the card sends strip and none is live', () => {
    // The guard is on a LIVE strip, not on strips. A currency with none must
    // still be able to open its first ladder.
    const ticket = composeDecisionBookTicket({
      template: stubTicket({ id: 'tpl', status: undefined }),
      amountLocalM: 14.65,
      isUnwind: false,
      liveStripOnBook: false,
      prepared: stripPrep,
      structure: 'strip',
      maturity: '1y',
      maturityLabel: '12M',
      varUsdM: 0.4,
    });
    expect(ticket.stripId).toMatch(/^strip-EUR-/);
    expect(ticket.sourcePackage?.structure).toBe('strip');
  });

  it('first strip book (nothing live yet) composes a new unfilled strip', () => {
    const ticket = composeDecisionBookTicket({
      template: stubTicket({ id: 'tpl', status: undefined }),
      amountLocalM: 14.65,
      isUnwind: false,
      liveStripOnBook: false,
      prepared: stripPrep,
      maturity: '1y',
      maturityLabel: '12M',
      varUsdM: 0.4,
    });
    expect(ticket.stripId).toMatch(/^strip-EUR-/);
    expect(ticket.stripId).not.toBe('strip-EUR-old');
    expect(ticket.status).toBeUndefined();
    expect(ticket.filledAtMs).toBeUndefined();
    expect(ticket.sourcePackage?.structure).toBe('strip');
    expect(ticket.sourcePackage?.coverLocalM).toBeCloseTo(14.65);
  });
});

describe('ticketOpensAsStrip', () => {
  const bulletPkg: PreparedHedgeProfile = {
    structure: 'bullet',
    basis: 'varNeutral',
    ticketBasis: 'simpleAvg',
    legs: [],
    coverLocalM: -0.02,
    hedgeRatio: 1,
    settleMonths: 7,
  };
  const stripPkg: PreparedHedgeProfile = {
    structure: 'strip',
    basis: 'varNeutral',
    ticketBasis: 'simpleAvg',
    legs: [
      {
        index: 0,
        startMonth: 0,
        endMonth: 2,
        settleMonths: 2,
        hedgeLocalM: 2.02,
        tradeNotionalLocalM: 2.02,
        label: 'L1',
      },
      {
        index: 1,
        startMonth: 0,
        endMonth: 4,
        settleMonths: 4,
        hedgeLocalM: 4.04,
        tradeNotionalLocalM: 2.02,
        label: 'L2',
      },
    ],
    coverLocalM: 4.04,
    hedgeRatio: 1,
  };

  it('opens an unwind buy-back as a bullet even with nothing staged', () => {
    // The reported defect. Sending a strip clears the staged package, so the
    // compose for the leftover overhedge carries neither a stripId nor a
    // sourcePackage — while the card's toggle still reads Strip. Taking the
    // toggle opened the buy-back in strip mode, where the missing stripId
    // sent it to a default seed ladder that then matched the booked legs by
    // edge index: rows under the wrong tenors, all showing as executed.
    expect(
      ticketOpensAsStrip({
        ticket: { stripId: undefined, sourcePackage: undefined },
        bookSession: true,
        decisionStructure: 'strip',
        prepared: null,
      }),
    ).toBe(false);
  });

  it('opens an unwind buy-back as a bullet when a strip is still staged', () => {
    expect(
      ticketOpensAsStrip({
        ticket: { stripId: undefined, sourcePackage: bulletPkg },
        bookSession: true,
        decisionStructure: 'strip',
        prepared: stripPkg,
      }),
    ).toBe(false);
  });

  it('opens a fresh strip Book as a strip — the compose mints its stripId', () => {
    expect(
      ticketOpensAsStrip({
        ticket: { stripId: 'strip-EUR-new', sourcePackage: stripPkg },
        bookSession: true,
        decisionStructure: 'strip',
        prepared: stripPkg,
      }),
    ).toBe(true);
  });

  it('follows the card toggle for a draft that is not a Book compose', () => {
    // After a Reset there is no package and no stamp; a card sitting on
    // Strip must still open the modal as a strip.
    expect(
      ticketOpensAsStrip({
        ticket: { stripId: undefined, sourcePackage: undefined },
        bookSession: false,
        decisionStructure: 'strip',
        prepared: null,
      }),
    ).toBe(true);
    expect(
      ticketOpensAsStrip({
        ticket: { stripId: undefined, sourcePackage: undefined },
        bookSession: false,
        decisionStructure: 'bullet',
        prepared: stripPkg,
      }),
    ).toBe(false);
  });

  it('lets a booked strip ticket win over a card sitting on Bullet', () => {
    expect(
      ticketOpensAsStrip({
        ticket: { stripId: 'strip-EUR-live', sourcePackage: undefined },
        bookSession: false,
        decisionStructure: 'bullet',
        prepared: null,
      }),
    ).toBe(true);
  });

  it('reads a stamped package on a blotter draft with no card toggle', () => {
    expect(
      ticketOpensAsStrip({
        ticket: { stripId: undefined, sourcePackage: bulletPkg },
        bookSession: false,
        decisionStructure: null,
        prepared: stripPkg,
      }),
    ).toBe(false);
    expect(
      ticketOpensAsStrip({
        ticket: { stripId: undefined, sourcePackage: undefined },
        bookSession: false,
        decisionStructure: null,
        prepared: stripPkg,
      }),
    ).toBe(true);
  });
});

describe('preparedByCcyAlignedToMix', () => {
  it('scales a 100% JPY carry bullet to the mix leftover on Cash Carry Book', () => {
    expect(mixRatiosAreActive({ JPY: 0.16, EUR: 1 })).toBe(true);
    const next = preparedByCcyAlignedToMix({
      preparedByCcy: {
        JPY: {
          ...stubProfile(),
          preparedFor: 'carry',
          coverLocalM: -1862.32,
          hedgeRatio: 1,
        },
      },
      hedgeRatios: { JPY: 0.16, EUR: 1 },
      bookedTickets: [],
      forecastByCcy: { JPY: -1862.32, EUR: 14.65 },
      settleMonths: 12,
    });
    expect(next.JPY?.coverLocalM).toBeCloseTo(-1862.32 * 0.16, 4);
    expect(next.JPY?.hedgeRatio).toBeCloseTo(0.16);
    expect(next.JPY?.preparedFor).toBe('carry');
    expect(next.EUR?.coverLocalM).toBeCloseTo(14.65);
    expect(next.EUR?.hedgeRatio).toBeCloseTo(1);
  });

  it('leaves packages unchanged when mix weights are all zero', () => {
    const prev = {
      JPY: {
        ...stubProfile(),
        preparedFor: 'carry' as const,
        coverLocalM: -1862.32,
        hedgeRatio: 1,
      },
    };
    const next = preparedByCcyAlignedToMix({
      preparedByCcy: prev,
      hedgeRatios: { JPY: 0, EUR: 0 },
      bookedTickets: [],
      forecastByCcy: { JPY: -1862.32 },
      settleMonths: 12,
    });
    expect(next.JPY?.coverLocalM).toBeCloseTo(-1862.32);
  });
});

describe('clearLiveBulletForCcy', () => {
  const G = GROUP_HEDGE_SCOPE;

  it('drops the live bullet for the CCY so a re-book replaces rather than stacks', () => {
    const booked = [
      stubTicket({ id: 'eur-1', ccy: 'EUR', amountLocalM: 12, entityId: G }),
      stubTicket({ id: 'gbp-1', ccy: 'GBP', amountLocalM: 8, entityId: G }),
    ];
    expect(clearLiveBulletForCcy(booked, 'EUR', G, 'forward').map(t => t.id)).toEqual([
      'gbp-1',
    ]);
  });

  it('booking EUR twice leaves one cover, not two', () => {
    const first = stubTicket({ id: 'eur-1', ccy: 'EUR', amountLocalM: 12, entityId: G });
    const second = stubTicket({ id: 'eur-2', ccy: 'EUR', amountLocalM: 12, entityId: G });
    // Mirrors the Decision Layer book path: prepend after clearing the prior bullet.
    const afterFirst = [first, ...clearLiveBulletForCcy([], 'EUR', G, 'forward')];
    const afterSecond = [second, ...clearLiveBulletForCcy(afterFirst, 'EUR', G, 'forward')];
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.id).toBe('eur-2');
    expect(afterSecond.reduce((a, t) => a + t.amountLocalM, 0)).toBe(12);
  });

  it('never touches another entity — group book is the cross-entity aggregate', () => {
    // Regression: a ccy-only filter deleted every entity's EUR bullet when the
    // consolidated desk booked EUR, silently destroying their cover.
    const booked = [
      stubTicket({ id: 'e1-eur', ccy: 'EUR', amountLocalM: 40, entityId: 'e1' }),
      stubTicket({ id: 'e2-eur', ccy: 'EUR', amountLocalM: 25, entityId: 'e2' }),
      stubTicket({ id: 'grp-eur', ccy: 'EUR', amountLocalM: 10, entityId: G }),
    ];
    const next = clearLiveBulletForCcy(booked, 'EUR', G, 'forward');
    expect(next.map(t => t.id)).toEqual(['e1-eur', 'e2-eur']);
    expect(next.reduce((a, t) => a + t.amountLocalM, 0)).toBe(65);
  });

  it('supersedes only within the booking entity on an entity desk', () => {
    const booked = [
      stubTicket({ id: 'e1-eur', ccy: 'EUR', entityId: 'e1' }),
      stubTicket({ id: 'e2-eur', ccy: 'EUR', entityId: 'e2' }),
    ];
    expect(clearLiveBulletForCcy(booked, 'EUR', 'e1', 'forward').map(t => t.id)).toEqual([
      'e2-eur',
    ]);
  });

  it('treats an unstamped ticket as group scope', () => {
    const booked = [stubTicket({ id: 'unstamped', ccy: 'EUR' })];
    expect(clearLiveBulletForCcy(booked, 'EUR', G, 'forward')).toEqual([]);
    expect(clearLiveBulletForCcy(booked, 'EUR', 'e1', 'forward')).toEqual(booked);
  });

  it('leaves strip legs alone — those are replaced by mergeRollingStripIntoBook', () => {
    const booked = [
      stubTicket({ id: 'leg-0', ccy: 'EUR', stripId: 's1', stripEdgeIndex: 0, entityId: G }),
      stubTicket({ id: 'leg-1', ccy: 'EUR', stripId: 's1', stripEdgeIndex: 1, entityId: G }),
    ];
    expect(clearLiveBulletForCcy(booked, 'EUR', G, 'forward').map(t => t.id)).toEqual([
      'leg-0',
      'leg-1',
    ]);
  });

  it('leaves scheduled tickets alone — a planned roll is not a re-book', () => {
    const booked = [
      stubTicket({ id: 'sched', ccy: 'EUR', status: 'scheduled', entityId: G }),
      stubTicket({ id: 'live', ccy: 'EUR', status: 'booked', entityId: G }),
    ];
    expect(clearLiveBulletForCcy(booked, 'EUR', G, 'forward').map(t => t.id)).toEqual([
      'sched',
    ]);
  });

  it('is a no-op for a CCY with nothing booked (single-currency / zero-exposure edge)', () => {
    const booked = [stubTicket({ id: 'gbp-1', ccy: 'GBP', entityId: G })];
    expect(clearLiveBulletForCcy(booked, 'EUR', G, 'forward')).toEqual(booked);
    expect(clearLiveBulletForCcy([], 'EUR', G, 'forward')).toEqual([]);
  });

  it('a forward never drops a live option on the same CCY', () => {
    // Regression: an option carries a paid premium and is a separate position.
    // Superseding it on a forward book would destroy it silently.
    const booked = [
      stubTicket({ id: 'eur-opt', ccy: 'EUR', instrument: 'option', entityId: G }),
      stubTicket({ id: 'eur-fwd', ccy: 'EUR', instrument: 'forward', entityId: G }),
      stubTicket({ id: 'eur-spot', ccy: 'EUR', instrument: 'spot', entityId: G }),
    ];
    expect(clearLiveBulletForCcy(booked, 'EUR', G, 'forward').map(t => t.id)).toEqual([
      'eur-opt',
      'eur-spot',
    ]);
    expect(clearLiveBulletForCcy(booked, 'EUR', G, 'option').map(t => t.id)).toEqual([
      'eur-fwd',
      'eur-spot',
    ]);
  });
});

describe('hasLiveCoverForCcy', () => {
  const G = GROUP_HEDGE_SCOPE;

  it('is true for a live option — the Book button must close on any cover', () => {
    // The reported symptom: EUR showed "1 booked" (a live option) yet Book
    // stayed enabled because the guard only asked about rolling strips.
    const booked = [
      stubTicket({ id: 'eur-opt', ccy: 'EUR', instrument: 'option', entityId: G }),
    ];
    expect(hasLiveCoverForCcy(booked, 'EUR', G)).toBe(true);
  });

  it('ignores other entities, other CCYs, strips and scheduled tickets', () => {
    expect(
      hasLiveCoverForCcy(
        [stubTicket({ id: 'e1', ccy: 'EUR', entityId: 'e1' })],
        'EUR',
        G,
      ),
    ).toBe(false);
    expect(
      hasLiveCoverForCcy([stubTicket({ id: 'g', ccy: 'GBP', entityId: G })], 'EUR', G),
    ).toBe(false);
    expect(
      hasLiveCoverForCcy(
        [stubTicket({ id: 'leg', ccy: 'EUR', stripId: 's1', entityId: G })],
        'EUR',
        G,
      ),
    ).toBe(false);
    expect(
      hasLiveCoverForCcy(
        [stubTicket({ id: 's', ccy: 'EUR', status: 'scheduled', entityId: G })],
        'EUR',
        G,
      ),
    ).toBe(false);
  });

  it('is false when nothing is booked', () => {
    expect(hasLiveCoverForCcy([], 'EUR', G)).toBe(false);
  });
});

describe('modeledHedgeCarryUsdM', () => {
  it('reads the staged package when one is present, ignoring any booked carry', () => {
    // Mirrors coverPreparedForLadder's own precedence in tenor-risk-ladder.ts:
    // a staged regime (what the desk is currently modeling) takes priority
    // over what happens to already be booked.
    const staged = stubProfile(0.137);
    const booked = [
      stubTicket({
        id: 'eur-fwd',
        ccy: 'EUR',
        sourcePackage: stubProfile(0.5),
      }),
    ];
    expect(modeledHedgeCarryUsdM(staged, booked)).toBeCloseTo(0.137, 9);
  });

  it('a staged package with zero cover does not count as "staged" — falls back to booked', () => {
    const staged: PreparedHedgeProfile = { ...stubProfile(0.9), coverLocalM: 0 };
    const booked = [
      stubTicket({ id: 'a', ccy: 'EUR', sourcePackage: stubProfile(0.2) }),
    ];
    expect(modeledHedgeCarryUsdM(staged, booked)).toBeCloseTo(0.2, 9);
  });

  it('with nothing staged, sums booked live tickets’ carry (a strip’s total lives on one leg)', () => {
    const booked = [
      stubTicket({
        id: 'leg-0',
        ccy: 'EUR',
        stripId: 's1',
        stripEdgeIndex: 0,
        sourcePackage: stubProfile(0.34),
      }),
      stubTicket({ id: 'leg-1', ccy: 'EUR', stripId: 's1', stripEdgeIndex: 1 }),
    ];
    expect(modeledHedgeCarryUsdM(null, booked)).toBeCloseTo(0.34, 9);
  });

  it('sums two separately-booked bullets rather than picking one', () => {
    const booked = [
      stubTicket({ id: 'a', ccy: 'EUR', sourcePackage: stubProfile(0.1) }),
      stubTicket({ id: 'b', ccy: 'EUR', sourcePackage: stubProfile(0.05) }),
    ];
    expect(modeledHedgeCarryUsdM(undefined, booked)).toBeCloseTo(0.15, 9);
  });

  it('excludes a scheduled (not-yet-live) ticket from the booked fallback', () => {
    const booked = [
      stubTicket({
        id: 'sched',
        ccy: 'EUR',
        status: 'scheduled',
        sourcePackage: stubProfile(0.7),
      }),
    ];
    expect(modeledHedgeCarryUsdM(null, booked)).toBe(0);
  });

  it('is zero with neither a staged package nor any booked ticket', () => {
    expect(modeledHedgeCarryUsdM(null, [])).toBe(0);
  });

  it('a booked ticket carrying no sourcePackage contributes nothing (never NaN)', () => {
    const booked = [stubTicket({ id: 'no-pkg', ccy: 'EUR' })];
    expect(modeledHedgeCarryUsdM(null, booked)).toBe(0);
  });
});

describe('preparedHedgeFromBookedTickets', () => {
  it('rebuilds a strip from booked legs when no snapshot was attached', () => {
    const booked = [
      stubTicket({
        id: 'a',
        amountLocalM: 5.5,
        maturity: '6m',
        maturityLabel: 'M0–M6 · settle M6 · 6M',
        stripId: 's1',
        stripEdgeIndex: 0,
      }),
      stubTicket({
        id: 'b',
        amountLocalM: 3.6,
        maturity: '1y',
        maturityLabel: 'M0–M12 · settle M12 · 12M',
        stripId: 's1',
        stripEdgeIndex: 1,
      }),
    ];
    const pkg = preparedHedgeFromBookedTickets(booked, booked[1]!);
    expect(pkg?.structure).toBe('strip');
    expect(pkg?.basis).toBe('totalExpected');
    expect(pkg?.legs).toHaveLength(2);
    expect(pkg?.coverLocalM).toBeCloseTo(9.1);
    expect(pkg?.legs[0]!.settleMonths).toBe(6);
    expect(pkg?.legs[0]!.tradeNotionalLocalM).toBeCloseTo(5.5);
    expect(pkg?.legs[1]!.settleMonths).toBe(12);
    expect(pkg?.legs[1]!.hedgeLocalM).toBeCloseTo(9.1);
  });

  it('prefers the package stamped at book over reconstructing the tickets', () => {
    const source: PreparedHedgeProfile = {
      structure: 'strip',
      basis: 'varNeutral',
      ticketBasis: 'simpleAvg',
      legs: [
        {
          index: 0,
          startMonth: 0,
          endMonth: 4,
          settleMonths: 4,
          hedgeLocalM: 8.23,
          tradeNotionalLocalM: 8.23,
          label: 'L1',
        },
      ],
      coverLocalM: 8.23,
      hedgeRatio: 0.68,
      preparedFor: 'carry',
      impliedCarryUsdM: 0.041,
    };
    const booked = stampSourcePackage(
      [
        stubTicket({
          id: 'a',
          amountLocalM: 5,
          stripId: 's1',
          stripEdgeIndex: 0,
          maturityLabel: 'M0–M6 · settle M6 · 6M',
        }),
        stubTicket({
          id: 'b',
          amountLocalM: 3.23,
          stripId: 's1',
          stripEdgeIndex: 1,
          maturityLabel: 'M0–M12 · settle M12 · 12M',
        }),
      ],
      source,
    );
    const pkg = preparedHedgeFromBookedTickets(booked, booked[1]!);
    expect(pkg?.basis).toBe('varNeutral');
    expect(pkg?.coverLocalM).toBeCloseTo(8.23);
    expect(pkg?.hedgeRatio).toBeCloseTo(0.68);
    expect(pkg?.preparedFor).toBe('carry');
    expect(pkg?.impliedCarryUsdM).toBeCloseTo(0.041);
  });

  it('reads settle months from ticket labels', () => {
    expect(
      settleMonthsFromHedgeTicket(
        stubTicket({ id: 'x', maturityLabel: 'M0–M9 · settle M9 · 9M' }),
      ),
    ).toBe(9);
    expect(
      settleMonthsFromHedgeTicket(
        stubTicket({ id: 'y', maturityLabel: 'L2 · settle t=6.5 · 6M' }),
      ),
    ).toBe(6.5);
    expect(
      settleMonthsFromHedgeTicket(
        stubTicket({ id: 'z', maturity: '3m', maturityLabel: '3M · bullet Tf' }),
      ),
    ).toBe(3);
  });
});

describe('stripPackageForTicketView', () => {
  const parentFive: PreparedHedgeProfile = {
    structure: 'strip',
    basis: 'varNeutral',
    ticketBasis: 'simpleAvg',
    legs: Array.from({ length: 5 }, (_, i) => ({
      index: i,
      startMonth: i === 0 ? 0 : (i * 12) / 5,
      endMonth: ((i + 1) * 12) / 5,
      settleMonths: ((i + 1) * 12) / 5,
      hedgeLocalM: (i + 1) * 1,
      tradeNotionalLocalM: 1,
      label: `L${i + 1}`,
    })),
    coverLocalM: 5,
    hedgeRatio: 1,
    preparedFor: 'var',
  };

  it('rebuilds all booked edges when the parent stamp is the shorter HD default', () => {
    const legs = Array.from({ length: 12 }, (_, i) =>
      stubTicket({
        id: `e${i}`,
        amountLocalM: 0.4,
        stripId: 's12',
        stripEdgeIndex: i,
        maturityLabel: `L${i + 1} · settle t=${((i + 1) * 12) / 12} · 1M`,
      }),
    );
    const booked = stampSourcePackage(legs, parentFive);
    const pkg = stripPackageForTicketView(booked, booked[3]!);
    expect(pkg?.structure).toBe('strip');
    expect(pkg?.legs).toHaveLength(12);
    expect(pkg?.coverLocalM).toBeCloseTo(4.8);
  });

  it('keeps the ladder when only one non-first leg has executed', () => {
    // Reopening a strip whose first leg was never traded: the shape rides
    // on whichever leg booked, so the panel must still see all 5 edges.
    // Without a stamp this collapses to a 1-leg package and the panel
    // falls back to a synthetic ladder whose edges do not line up with
    // the booked leg — every leg then shows the wrong executed status.
    const booked = stampSourcePackage(
      [
        stubTicket({
          id: 'l2',
          amountLocalM: 2,
          stripId: 'sp',
          stripEdgeIndex: 1,
          status: 'booked',
          filledAtMs: 1_800_000_000_000,
        }),
      ],
      parentFive,
    );
    const pkg = stripPackageForTicketView(booked, booked[0]!);
    expect(pkg?.structure).toBe('strip');
    expect(pkg?.legs).toHaveLength(5);
  });

  it('takes the largest ladder any ticket of the strip was stamped with', () => {
    // Two legs booked off a 2-leg ladder, then the desk added a third leg in
    // the modal and left a stop on leg 2: that bracket carries the 3-leg
    // stamp while the first leg still carries the 2-leg one. The strip's
    // shape is the 3-leg ladder, whichever ticket sits first.
    const two: PreparedHedgeProfile = {
      ...parentFive,
      legs: parentFive.legs.slice(0, 2),
      coverLocalM: 2,
    };
    const three: PreparedHedgeProfile = {
      ...parentFive,
      legs: parentFive.legs.slice(0, 3),
      coverLocalM: 3,
    };
    const booked = [
      stubTicket({
        id: 'm0',
        amountLocalM: 1,
        stripId: 'sp3',
        stripEdgeIndex: 0,
        status: 'booked',
        filledAtMs: 1_800_000_000_000,
        sourcePackage: two,
      }),
      stubTicket({
        id: 'sl1',
        instrument: 'spot',
        amountLocalM: 1,
        stripId: 'sp3',
        stripEdgeIndex: 1,
        status: 'booked',
        bracketRole: 'stopLoss',
        orderType: 'oco',
        limitRate: 1.164,
        filledAtMs: 1_800_000_060_000,
        sourcePackage: three,
      }),
    ];
    expect(stripPackageForTicketView(booked, booked[0]!)?.legs).toHaveLength(3);
    expect(stripPackageForTicketView(booked, booked[1]!)?.legs).toHaveLength(3);
  });

  it('rejects a larger stamp that contradicts the booked legs\' own tenors', () => {
    // The reported defect: a strip reshaped in the modal to M1/M2/M3/M5/M8.
    // Its market-filled L1 carried that ladder; the OCO orders left on the
    // other legs carried the card's six-leg M2…M12 ladder they were never
    // part of. "Largest wins" took the six-leg one, so L1 (an M1 fill at
    // spot + 14.9 pips) was labelled M2 and charted at spot + 28 pips.
    const ladder = (ends: readonly number[]): PreparedHedgeProfile => ({
      ...parentFive,
      legs: ends.map((end, i) => ({
        index: i,
        startMonth: 0,
        endMonth: end,
        settleMonths: end,
        hedgeLocalM: i + 1,
        tradeNotionalLocalM: 1,
        label: `L${i + 1} · M${end}`,
      })),
      coverLocalM: ends.length,
    });
    const booked = [
      stubTicket({
        id: 'l1',
        amountLocalM: 3.05,
        stripId: 'sp5',
        stripEdgeIndex: 0,
        maturityMonths: 1,
        status: 'booked',
        filledAtMs: 1_789_506_391_315,
        sourcePackage: ladder([1, 2, 3, 5, 8]),
      }),
      stubTicket({
        id: 'sl2',
        amountLocalM: 1.4,
        stripId: 'sp5',
        stripEdgeIndex: 1,
        maturityMonths: 2,
        status: 'booked',
        bracketRole: 'stopLoss',
        orderType: 'oco',
        limitRate: 1.153,
        filledAtMs: 1_789_506_414_452,
        sourcePackage: ladder([2, 4, 6, 8, 10, 12]),
      }),
    ];
    for (const view of booked) {
      const pkg = stripPackageForTicketView(booked, view);
      expect(pkg?.legs.map(leg => leg.endMonth)).toEqual([1, 2, 3, 5, 8]);
    }
  });

  it('keeps a Carry-approved stamp even when ticket count differs', () => {
    const source: PreparedHedgeProfile = {
      ...parentFive,
      preparedFor: 'carry',
      impliedCarryUsdM: 0.02,
    };
    const booked = stampSourcePackage(
      [
        stubTicket({ id: 'a', amountLocalM: 2, stripId: 'sc', stripEdgeIndex: 0 }),
        stubTicket({ id: 'b', amountLocalM: 3, stripId: 'sc', stripEdgeIndex: 1 }),
      ],
      source,
    );
    const pkg = stripPackageForTicketView(booked, booked[1]!);
    expect(pkg?.preparedFor).toBe('carry');
    expect(pkg?.legs).toHaveLength(5);
    expect(pkg?.impliedCarryUsdM).toBeCloseTo(0.02);
  });

  it('rebuilds when more edges were booked than the parent stamp', () => {
    const three: PreparedHedgeProfile = {
      ...parentFive,
      preparedFor: 'var',
      legs: parentFive.legs.slice(0, 3),
      coverLocalM: 3,
    };
    const legs = Array.from({ length: 6 }, (_, i) =>
      stubTicket({
        id: `m${i}`,
        amountLocalM: 1.99 - i * 0.05,
        stripId: 's6',
        stripEdgeIndex: i,
        filledAtMs: 1,
        orderHit: 'bid',
        maturityLabel: `L${i + 1} · settle t=${i + 1} · 1M`,
      }),
    );
    const tp = stubTicket({
      id: 'm0-tp',
      amountLocalM: 1.99,
      stripId: 's6',
      stripEdgeIndex: 0,
      bracketRole: 'takeProfit',
      filledAtMs: 2,
      orderHit: 'bid',
      limitRate: 1.1659,
    });
    const booked = stampSourcePackage([...legs, tp], three);
    const pkg = stripPackageForTicketView(booked, booked[0]!);
    expect(pkg?.legs).toHaveLength(6);
    expect(pkg?.legs[0]!.tradeNotionalLocalM).toBeCloseTo(1.99);
    expect(preferredStripEdgeTickets(booked)[0]!.id).toBe('m0');
  });

  it('rebuilds from CCY strip peers when the viewing ticket has no stripId', () => {
    const legs = Array.from({ length: 12 }, (_, i) =>
      stubTicket({
        id: `e${i}`,
        amountLocalM: 0.4,
        stripId: 's12',
        stripEdgeIndex: i,
        maturityLabel: `L${i + 1} · settle t=${i + 1} · 1M`,
      }),
    );
    const booked = stampSourcePackage(legs, parentFive);
    const orphan = stubTicket({ id: 'draft', amountLocalM: 5.08 });
    const pkg = stripPackageForTicketView(booked, orphan);
    expect(pkg?.structure).toBe('strip');
    expect(pkg?.legs).toHaveLength(12);
  });

  it('does not inherit a live CCY strip onto a free Decision Book compose ticket', () => {
    const legs = Array.from({ length: 8 }, (_, i) =>
      stubTicket({
        id: `e${i}`,
        amountLocalM: 0.32,
        stripId: 's8',
        stripEdgeIndex: i,
        filledAtMs: 1,
        orderHit: 'bid',
        maturityLabel: `L${i + 1} · settle t=${i + 1} · 1M`,
      }),
    );
    const booked = stampSourcePackage(legs, parentFive);
    const compose = stubTicket({
      id: 'book-clip',
      amountLocalM: 2.55,
      status: undefined,
    });
    const { status: _status, ...free } = compose;
    const pkg = stripPackageForTicketView(booked, free as HedgeTicket);
    expect(pkg?.structure).not.toBe('strip');
  });
});

describe('packageForStructure live vs nested strip', () => {
  const five: PreparedHedgeProfile = {
    structure: 'strip',
    basis: 'varNeutral',
    ticketBasis: 'simpleAvg',
    legs: Array.from({ length: 5 }, (_, i) => ({
      index: i,
      startMonth: 0,
      endMonth: ((i + 1) * 12) / 5,
      settleMonths: ((i + 1) * 12) / 5,
      hedgeLocalM: i + 1,
      tradeNotionalLocalM: 1,
      label: `L${i + 1}`,
    })),
    coverLocalM: 5,
    hedgeRatio: 1,
    preparedFor: 'var',
  };
  const twelve: PreparedHedgeProfile = {
    ...five,
    legs: Array.from({ length: 12 }, (_, i) => ({
      index: i,
      startMonth: 0,
      endMonth: i + 1,
      settleMonths: i + 1,
      hedgeLocalM: (i + 1) * 0.4,
      tradeNotionalLocalM: 0.4,
      label: `L${i + 1}`,
    })),
    coverLocalM: 4.8,
  };

  it('keeps a 12-leg live ladder over a leftover 5-leg packages.strip parent', () => {
    const staged = {
      ...twelve,
      packages: { strip: five },
    };
    const pkg = packageForStructure(staged, 'strip');
    expect(pkg?.legs).toHaveLength(12);
    expect(pkg?.coverLocalM).toBeCloseTo(4.8);
  });

  it('keeps a nested Carry strip when it is at least as long as the live legs', () => {
    const carry: PreparedHedgeProfile = {
      ...five,
      preparedFor: 'carry',
      impliedCarryUsdM: 0.02,
    };
    const staged = {
      ...five,
      preparedFor: 'var' as const,
      packages: { strip: carry },
    };
    const pkg = packageForStructure(staged, 'strip');
    expect(pkg?.preparedFor).toBe('carry');
    expect(pkg?.legs).toHaveLength(5);
    expect(pkg?.impliedCarryUsdM).toBeCloseTo(0.02);
  });
});

describe('hedgeTicketExecutionState', () => {
  it('treats a booked fill as FILLED even if the cap note is still on the quote', () => {
    const filled = stubTicket({
      id: 'eur-sl',
      status: 'booked',
      filledAtMs: 1,
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.17,
        fxOutright: 1.1657,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
        errorMessage: OVER_AUTOMATED_LIMIT_NOTE,
      },
    });
    expect(hedgeTicketExecutionState(filled, Date.now())).toBe('FILLED');
  });

  it('holds a still-working order at the automated cap', () => {
    const held = stubTicket({
      id: 'eur-tp',
      status: 'scheduled',
      limitRate: 1.176,
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.17,
        fxOutright: null,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
        errorMessage: OVER_AUTOMATED_LIMIT_NOTE,
      },
    });
    expect(hedgeTicketExecutionState(held, Date.now())).toBe('HELD');
  });

  it('drops the cap note once the matcher books a fill', () => {
    const next = quoteAfterFill(
      {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.17,
        fxOutright: null,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
        errorMessage: OVER_AUTOMATED_LIMIT_NOTE,
      },
      { fxOutright: 1.1657, fxSpot: 1.17 },
    );
    expect(next.errorMessage).toBeUndefined();
    expect(next.fxOutright).toBe(1.1657);
    expect(hedgeTicketExecutionState(
      stubTicket({ id: 'f', status: 'booked', ipaQuote: next }),
      Date.now(),
    )).toBe('FILLED');
  });

  it('books a spot-referenced strip leg at its spot execution plus the leg points', () => {
    // Hand check: 1.16529 + 42.01 EURUSD pips = 1.16529 + 0.004201 = 1.169491.
    const leg = stubTicket({ id: 'm4-tp', isSpotReferenced: true, stripLegPoints: 42.01 });
    expect(spotReferencedFillQuote(leg, 1.16529)).toEqual({
      fxOutright: 1.169491,
      fxSpot: 1.16529,
    });
  });

  it('applies the JPY /100 points convention to a spot-referenced leg', () => {
    // Hand check: 147.25 + (−120 × 0.01) = 146.05.
    const leg = stubTicket({
      id: 'jpy-tp',
      ccy: 'JPY',
      isSpotReferenced: true,
      stripLegPoints: -120,
    });
    expect(spotReferencedFillQuote(leg, 147.25)).toEqual({
      fxOutright: 146.05,
      fxSpot: 147.25,
    });
  });

  it('leaves every other fill to its caller', () => {
    expect(spotReferencedFillQuote(stubTicket({ id: 'fwd', stripLegPoints: 42.01 }), 1.16529))
      .toBeNull();
    expect(spotReferencedFillQuote(stubTicket({ id: 'spot', instrument: 'spot' }), 1.16529))
      .toBeNull();
  });

  it('treats a booked print as market-executed, not an M0 strip restage', () => {
    expect(isMarketExecutedHedgeTicket(stubTicket({
      id: 'print',
      status: 'booked',
      filledAtMs: 1,
      orderHit: 'bid',
    }))).toBe(true);
    expect(isMarketExecutedHedgeTicket(stubTicket({
      id: 'm0',
      status: 'booked',
      stripId: 's1',
      stripEdgeIndex: 0,
    }))).toBe(false);
    expect(isMarketExecutedHedgeTicket(stubTicket({
      id: 'rest',
      status: 'scheduled',
      limitRate: 1.17,
      filledAtMs: 1,
    }))).toBe(false);
  });
});

describe('decisionCcyOrderCounts / decisionStructureCaption', () => {
  const now = 1_700_000_000_000;

  it('counts a just-submitted strip OCO as pending, not filled', () => {
    const tickets: HedgeTicket[] = [0, 1, 2, 3, 4].flatMap(i => [
      stubTicket({
        id: `tp-${i}`,
        status: 'scheduled',
        limitRate: 1.18,
        stripId: 'strip-1',
        stripEdgeIndex: i,
        bracketRole: 'takeProfit',
      }),
      stubTicket({
        id: `sl-${i}`,
        status: 'scheduled',
        limitRate: 1.16,
        stripId: 'strip-1',
        stripEdgeIndex: i,
        bracketRole: 'stopLoss',
      }),
    ]);
    expect(decisionCcyOrderCounts(tickets, now)).toEqual({
      pending: 10,
      filled: 0,
    });
    expect(
      decisionStructureCaption({
        stagedLegs: 5,
        stagedKind: 'strip',
        isStrip: true,
        draftLegCount: 5,
        ...decisionCcyOrderCounts(tickets, now),
      }),
    ).toBe('5 staged strip · 10 pending');
  });

  it('splits filled covers from still-working brackets on the same tick', () => {
    const tickets: HedgeTicket[] = [
      stubTicket({
        id: 'l0',
        status: 'booked',
        filledAtMs: now,
        stripId: 'strip-1',
        stripEdgeIndex: 0,
        orderHit: 'bid',
      }),
      stubTicket({
        id: 'tp-1',
        status: 'scheduled',
        limitRate: 1.18,
        stripId: 'strip-1',
        stripEdgeIndex: 1,
        bracketRole: 'takeProfit',
      }),
      stubTicket({
        id: 'cx',
        status: 'cancelled',
        stripId: 'strip-1',
        stripEdgeIndex: 2,
      }),
    ];
    expect(decisionCcyOrderCounts(tickets, now)).toEqual({
      pending: 1,
      filled: 1,
    });
    expect(
      decisionStructureCaption({
        stagedLegs: 0,
        stagedKind: null,
        isStrip: true,
        draftLegCount: 5,
        pending: 1,
        filled: 1,
      }),
    ).toBe('1 filled · 1 pending');
  });

  it('does not claim a staged strip when the next trade is a buy-back', () => {
    // The reported defect: six legs filled leaving a small overhedge, so the
    // table below shows the single bullet buy-back — under a caption reading
    // "6 staged strip". The staged strip is real, but it is not what Book
    // trades here, and the two together read as a table missing five rows.
    expect(
      decisionStructureCaption({
        stagedLegs: 6,
        stagedKind: 'strip',
        isStrip: true,
        draftLegCount: 6,
        pending: 0,
        filled: 6,
        isUnwind: true,
      }),
    ).toBe('6 filled · unwind buy-back');
  });

  it('still names the staged strip when there is no overhedge', () => {
    expect(
      decisionStructureCaption({
        stagedLegs: 6,
        stagedKind: 'strip',
        isStrip: true,
        draftLegCount: 6,
        pending: 0,
        filled: 6,
        isUnwind: false,
      }),
    ).toBe('6 staged strip · 6 filled');
  });
});

describe('chartTicketsAtEdge / fillTicketAtEdge', () => {
  const cover = stubTicket({
    id: 'cover-0',
    status: 'booked',
    filledAtMs: 1_700_000_000_000,
    orderHit: 'bid',
    stripId: 'strip-1',
    stripEdgeIndex: 0,
    ipaQuote: {
      strike: null,
      strikeInput: '',
      premiumUsd: null,
      premiumPercent: null,
      fxSpot: 1.1629,
      fxOutright: 1.16293,
      atmVolPercent: null,
      impliedVolPercent: null,
      deltaPercent: null,
    },
  });
  const tp = stubTicket({
    id: 'tp-0',
    status: 'scheduled',
    limitRate: 1.1633,
    bracketRole: 'takeProfit',
    stripId: 'strip-1',
    stripEdgeIndex: 0,
    restingAnchorRate: 1.16293,
  });

  it('bracket focus keeps the resting TP level and hides the cover FILL arrow', () => {
    const tickets = [cover, tp];
    expect(chartTicketsAtEdge(tickets, 0, tp).map(t => t.id)).toEqual(['tp-0']);
    expect(fillTicketAtEdge(tickets, 0, tp)).toBeUndefined();
  });

  it('cover focus keeps working TP visible after the cover prints', () => {
    const tickets = [cover, tp];
    const levels = chartTicketsAtEdge(tickets, 0, cover);
    expect(levels.map(t => t.id)).toEqual(['tp-0']);
    expect(fillTicketAtEdge(tickets, 0, cover)?.id).toBe('cover-0');
  });

  it('bracket focus draws the TP fill only once that role books', () => {
    const filledTp = {
      ...tp,
      status: 'booked' as const,
      filledAtMs: 1_700_000_000_500,
      orderHit: 'ask' as const,
      ipaQuote: {
        ...cover.ipaQuote!,
        fxOutright: 1.16335,
      },
    };
    const tickets = [cover, filledTp];
    expect(chartTicketsAtEdge(tickets, 0, filledTp).map(t => t.id)).toEqual([
      'tp-0',
    ]);
    expect(fillTicketAtEdge(tickets, 0, filledTp)?.id).toBe('tp-0');
    expect(fillTicketAtEdge(tickets, 0, filledTp)?.ipaQuote?.fxOutright).toBe(
      1.16335,
    );
  });

  it('bracket focus keeps the OCO sibling that the fill auto-cancelled, alongside the fill', () => {
    // TP fills; its OCO sibling SL is auto-cancelled in place (status flips,
    // limitRate stays) rather than removed from the book — the chart should
    // still be able to draw where the SL was resting. Both carry the same
    // ocoGroupId, which is how the runtime pairs them: cancelledOrderIds is
    // only ever populated inside `if (t.ocoGroupId)`.
    const filledTp = {
      ...tp,
      status: 'booked' as const,
      filledAtMs: 1_700_000_000_500,
      orderHit: 'ask' as const,
      ocoGroupId: 'oco-a',
      ipaQuote: {
        ...cover.ipaQuote!,
        fxOutright: 1.16335,
      },
    };
    const cancelledSl = stubTicket({
      id: 'sl-0',
      status: 'cancelled',
      limitRate: 1.1601,
      bracketRole: 'stopLoss',
      ocoGroupId: 'oco-a',
      stripId: 'strip-1',
      stripEdgeIndex: 0,
      restingAnchorRate: 1.16293,
    });
    const tickets = [cover, filledTp, cancelledSl];
    // Opened from the fill (TP) or from the cancelled sibling (SL) — either
    // way the chart draws both.
    expect(chartTicketsAtEdge(tickets, 0, filledTp).map(t => t.id)).toEqual([
      'tp-0',
      'sl-0',
    ]);
    expect(chartTicketsAtEdge(tickets, 0, cancelledSl).map(t => t.id)).toEqual([
      'tp-0',
      'sl-0',
    ]);
    // A cancelled sibling never triggered — it must never become the FILL arrow.
    expect(fillTicketAtEdge(tickets, 0, cancelledSl)).toBeUndefined();
  });

  it('draws the cancelled sibling with no bracket focus — the chart is scoped by edge, not by who opened it', () => {
    // chartIsOwnLeg passes focus=null whenever the panel's chartTicket
    // resolves to another leg, which on a strip opened from the spot tile is
    // the common case. The grey level must not depend on that: the desk saw
    // the filled leg's line with no cancelled level anywhere.
    const filledTp = {
      ...tp,
      status: 'booked' as const,
      filledAtMs: 1_700_000_000_500,
      orderHit: 'ask' as const,
      ocoGroupId: 'oco-a',
    };
    const cancelledSl = stubTicket({
      id: 'sl-0',
      status: 'cancelled',
      limitRate: 1.1601,
      bracketRole: 'stopLoss',
      ocoGroupId: 'oco-a',
      stripId: 'strip-1',
      stripEdgeIndex: 0,
    });
    const ids = chartTicketsAtEdge([cover, filledTp, cancelledSl], 0, null)
      .map(t => t.id);
    expect(ids).toContain('sl-0');
  });

  it('draws only the cancelled sibling of THIS cycle, not one left by an earlier OCO on the same leg', () => {
    // Re-leaving an OCO on a leg that already cycled leaves the previous
    // round's cancelled sibling on the book. Matching on "cancelled and at
    // this edge" drew a grey level for every one of them — two cycles put
    // four lines on the chart, two from orders already finished with.
    const filledTp = {
      ...tp,
      status: 'booked' as const,
      filledAtMs: 1_700_000_000_500,
      orderHit: 'ask' as const,
      ocoGroupId: 'oco-b',
    };
    const thisCycleSl = stubTicket({
      id: 'sl-now',
      status: 'cancelled',
      limitRate: 1.1601,
      bracketRole: 'stopLoss',
      ocoGroupId: 'oco-b',
      stripId: 'strip-1',
      stripEdgeIndex: 0,
    });
    const earlierCycleSl = stubTicket({
      id: 'sl-old',
      status: 'cancelled',
      limitRate: 1.1555,
      bracketRole: 'stopLoss',
      ocoGroupId: 'oco-a',
      stripId: 'strip-1',
      stripEdgeIndex: 0,
    });
    const tickets = [cover, filledTp, thisCycleSl, earlierCycleSl];
    expect(chartTicketsAtEdge(tickets, 0, filledTp).map(t => t.id)).toEqual([
      'tp-0',
      'sl-now',
    ]);
    expect(chartTicketsAtEdge(tickets, 0, null).map(t => t.id)).not.toContain(
      'sl-old',
    );
  });

  it('bracket focus drops a cancelled sibling with no resting level', () => {
    const filledTp = {
      ...tp,
      status: 'booked' as const,
      filledAtMs: 1_700_000_000_500,
      orderHit: 'ask' as const,
    };
    const cancelledSlNoLevel = stubTicket({
      id: 'sl-0',
      status: 'cancelled',
      limitRate: undefined,
      bracketRole: 'stopLoss',
      stripId: 'strip-1',
      stripEdgeIndex: 0,
    });
    const tickets = [cover, filledTp, cancelledSlNoLevel];
    expect(chartTicketsAtEdge(tickets, 0, filledTp).map(t => t.id)).toEqual([
      'tp-0',
    ]);
  });
});

describe('isEditableWorkingOrder', () => {
  const working = stubTicket({
    id: 'tp',
    status: 'scheduled',
    bracketRole: 'takeProfit',
    limitRate: 1.1417,
  });

  it('accepts a working order with a level of its own', () => {
    expect(isEditableWorkingOrder(working)).toBe(true);
  });

  it('refuses an order that has already filled', () => {
    // The reported defect: Edit was offered on a filled order opened from the
    // blotter and the handler behind it returned silently.
    expect(
      isEditableWorkingOrder(
        stubTicket({
          id: 'tp',
          status: 'booked',
          bracketRole: 'takeProfit',
          limitRate: 1.1417,
          filledAtMs: 1_800_000_000_000,
        }),
      ),
    ).toBe(false);
  });

  it('refuses a cancelled order', () => {
    expect(isEditableWorkingOrder({ ...working, status: 'cancelled' })).toBe(false);
  });

  it('refuses a working ticket carrying no usable level', () => {
    for (const limitRate of [undefined, 0, Number.NaN]) {
      expect(
        isEditableWorkingOrder({ ...working, limitRate: limitRate as number | undefined }),
      ).toBe(false);
    }
  });

  it('refuses nothing at all rather than throwing', () => {
    expect(isEditableWorkingOrder(null)).toBe(false);
    expect(isEditableWorkingOrder(undefined)).toBe(false);
  });
});
