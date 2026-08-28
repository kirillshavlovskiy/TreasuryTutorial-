import { describe, it, expect } from 'vitest';
import { allocateSwapForwardOverlay } from '@/lib/fx-hedge';
import { emptyMarketRatesForCcy } from '@/lib/fx-market-rates';
import {
  bothBookScheduleFor,
  buildStandingStripToTerm,
  canLiquidityStageReplace,
  fundingStripPreparedProfile,
  fundingSwapTenorLabel,
  hedgeLegNotionalFcyM,
  hedgeLegNotionalUsdM,
  hedgeOverlayCfarUsdM,
  hedgeOverlayNotionalFcyM,
  hedgeOverlayNotionalUsdM,
  mergeResidualOverlays,
  overlayDeltaStub,
  peakFundingSwapBookM,
  residualForStage,
  residualNeedsFxStage,
  scaleFundingScheduleToBook,
  scenarioFundingScheduleFor,
  stripDisplayedSwapFcyM,
} from '@/lib/test-mode/liquidity-strip-stage';
import type { LiquiditySwapLegRow } from '@/lib/test-mode/liquidity-strategies';

const strip = [
  {
    cycleIndex: 0,
    valueDateMonths: 0,
    newLeg: -2.5,
    outstanding: -2.5,
    settleMonths: 12,
    preBookable: false,
  },
  {
    cycleIndex: 1,
    valueDateMonths: 1,
    newLeg: -1.4,
    outstanding: -3.9,
    settleMonths: 11,
    preBookable: true,
  },
];

describe('scaleFundingScheduleToBook', () => {
  const strip = [
    {
      cycleIndex: 0,
      valueDateMonths: 0,
      newLeg: -18.89,
      rolledForward: 0,
      outstanding: -18.89,
      settleMonths: 12,
      preBookable: false,
    },
    {
      cycleIndex: 11,
      valueDateMonths: 11,
      newLeg: -1.2,
      rolledForward: -11.89,
      outstanding: -12.09,
      settleMonths: 1,
      preBookable: true,
    },
  ];

  it('scales peak outstanding to the scenario Book S, not the terminal leg', () => {
    const scaled = scaleFundingScheduleToBook(strip, -15);
    expect(peakFundingSwapBookM(scaled)).toBeCloseTo(-15, 5);
    expect(scaled[0]!.outstanding).toBeCloseTo(-15, 5);
    expect(scaled[scaled.length - 1]!.outstanding).toBeCloseTo(-9.6, 1);
    expect(Math.abs(scaled[0]!.outstanding))
      .toBeGreaterThan(Math.abs(scaled[scaled.length - 1]!.outstanding));
  });

  it('header Swap Book uses peak so M1 cannot exceed it on a monotonic strip', () => {
    const monotonic = [
      { ...strip[0]!, outstanding: -2.5, newLeg: -2.5, rolledForward: 0 },
      { ...strip[1]!, outstanding: -12.09, newLeg: -9.59, rolledForward: -2.5 },
    ];
    const peak = peakFundingSwapBookM(monotonic);
    expect(peak).toBeCloseTo(-12.09, 5);
    expect(Math.abs(monotonic[0]!.outstanding)).toBeLessThanOrEqual(Math.abs(peak));
  });
});

describe('fundingStripPreparedProfile', () => {
  it('does not stage a far (Δ = 0) book', () => {
    expect(fundingStripPreparedProfile({
      ccy: 'EUR',
      schedule: strip,
      residual: 0,
      forecastMonths: 12,
    })).toBeNull();
    expect(residualNeedsFxStage(0)).toBe(false);
  });

  it('sizes one FX bullet at the modeled residual Δ — not a per-cycle strip', () => {
    const profile = fundingStripPreparedProfile({
      ccy: 'EUR',
      schedule: strip,
      residual: 0.4,
      forecastMonths: 12,
    });
    expect(profile).not.toBeNull();
    expect(profile!.preparedFor).toBe('liquidity');
    expect(profile!.structure).toBe('bullet');
    expect(profile!.legs).toHaveLength(0);
    expect(profile!.hedgeRatio).toBeCloseTo(0.4, 9);
    expect(profile!.coverLocalM).toBeCloseTo(-1.56, 9);
    expect(profile!.settleMonths).toBe(12);
    expect(residualNeedsFxStage(0.4)).toBe(true);
  });

  it('PLN surplus near (−newLeg) still stages a long cover so CIP earns', () => {
    const profile = fundingStripPreparedProfile({
      ccy: 'PLN',
      schedule: [
        {
          cycleIndex: 0,
          valueDateMonths: 0,
          newLeg: -21.6,
          outstanding: -21.6,
          settleMonths: 12,
          preBookable: false,
        },
      ],
      residual: 1,
      forecastMonths: 12,
      marketRates: emptyMarketRatesForCcy('PLN'),
    });
    expect(profile).not.toBeNull();
    expect(profile!.coverLocalM).toBeCloseTo(21.6, 9);
    expect(profile!.impliedCarryUsdM!).toBeGreaterThan(0);
  });

  it('PLN OD cover (+newLeg) earns CIP on the residual FX strip — not a buy', () => {
    const profile = fundingStripPreparedProfile({
      ccy: 'PLN',
      schedule: [
        {
          cycleIndex: 0,
          valueDateMonths: 0,
          newLeg: 21.6,
          outstanding: 21.6,
          settleMonths: 12,
          preBookable: false,
        },
      ],
      residual: 1,
      forecastMonths: 12,
      marketRates: emptyMarketRatesForCcy('PLN'),
    });
    expect(profile).not.toBeNull();
    expect(profile!.coverLocalM).toBeCloseTo(21.6, 9);
    expect(profile!.impliedCarryUsdM!).toBeGreaterThan(0);
  });

  it('stages a term programme as a bullet', () => {
    const profile = fundingStripPreparedProfile({
      ccy: 'EUR',
      schedule: [{
        cycleIndex: 0,
        valueDateMonths: 0,
        newLeg: -8,
        outstanding: -8,
        settleMonths: 12,
        preBookable: false,
      }],
      residual: 1,
      forecastMonths: 12,
    });
    expect(profile!.structure).toBe('bullet');
    expect(profile!.legs).toHaveLength(0);
    expect(profile!.coverLocalM).toBeCloseTo(-8, 9);
    expect(profile!.settleMonths).toBe(12);
  });
});

describe('canLiquidityStageReplace', () => {
  it('fills an empty CCY and replaces a liquidity package only', () => {
    expect(canLiquidityStageReplace(undefined)).toBe(true);
    expect(canLiquidityStageReplace({
      structure: 'bullet',
      basis: 'cash',
      ticketBasis: 'stock',
      legs: [],
      coverLocalM: 1,
      hedgeRatio: 0.4,
      preparedFor: 'liquidity',
    })).toBe(true);
    expect(canLiquidityStageReplace({
      structure: 'bullet',
      basis: 'cash',
      ticketBasis: 'stock',
      legs: [],
      coverLocalM: 2,
      hedgeRatio: 1,
      preparedFor: 'carry',
    })).toBe(false);
    expect(canLiquidityStageReplace({
      structure: 'strip',
      basis: 'varNeutral',
      ticketBasis: 'varNeutral',
      legs: [],
      coverLocalM: 2,
      hedgeRatio: 1,
      preparedFor: 'var',
    })).toBe(false);
  });
});

describe('residualForStage', () => {
  it('uses the CCY Δ when modeled, else the last mix Δ', () => {
    expect(residualForStage('EUR', { EUR: 0.4 }, 0.9)).toBe(0.4);
    expect(residualForStage('PLN', { EUR: 0.4 }, 0.9)).toBe(0.9);
    expect(residualForStage('PLN', { EUR: 0.4 }, null)).toBeUndefined();
  });
});

describe('mergeResidualOverlays', () => {
  it('replaces desk Δ with the modeled residual, converted to the hedge-coverage convention downstream readers expect', () => {
    // overlayDeltaStub's `residual` param is the frontier convention (1 =
    // open/nothing hedged); the stored `.delta` field it returns is the
    // OPPOSITE hedge-coverage convention (Δ=1 = fully hedged) that
    // retainedFundingPlanByCcy/overlayCipRetention actually read — so
    // .delta = 1 - residual. See overlayDeltaStub's own doc comment.
    const desk = {
      EUR: allocateSwapForwardOverlay({
        exposureLocalM: 10,
        swapNearLocalM: 6,
        delta: 1,
      }),
    };
    const merged = mergeResidualOverlays(desk, { EUR: 0.25, GBP: 0 });
    expect(merged.EUR!.delta).toBeCloseTo(0.75, 9); // residual=0.25 (mostly hedged) → delta=1-0.25
    expect(merged.EUR!.forwardLocalM).toBe(0);
    expect(merged.GBP!.delta).toBe(1); // residual=0 (fully hedged/far) → delta=1-0
    expect(overlayDeltaStub(1).delta).toBe(0); // residual=1 (fully open) → delta=1-1
  });
});

function opLeg(input: {
  cycleIndex: number;
  newLeg: number;
  outstanding: number;
}): LiquiditySwapLegRow {
  return {
    cycleIndex: input.cycleIndex,
    valueDateMonths: input.cycleIndex,
    newLeg: input.newLeg,
    rolledForward: input.outstanding - input.newLeg,
    outstanding: input.outstanding,
    preBookable: input.cycleIndex > 0,
    settleMonths: 1,
    fcyOnUsdYr: 0,
    usdOnUsdYr: 0,
    pointsUsdYr: 0,
    midPoints: null,
    hasPoints: true,
    interestUsdYr: 0,
    netUsdYr: 0,
  };
}

/** Pasted EUR rolling-preview operating path (Notional FCY = newLeg, Swap Book = outstanding). */
const EUR_OPERATING: LiquiditySwapLegRow[] = [
  opLeg({ cycleIndex: 0, newLeg: -2.50, outstanding: -2.50 }),
  opLeg({ cycleIndex: 1, newLeg: -1.40, outstanding: -3.90 }),
  opLeg({ cycleIndex: 2, newLeg: 6.38, outstanding: 2.48 }),
  opLeg({ cycleIndex: 3, newLeg: -1.40, outstanding: 1.08 }),
  opLeg({ cycleIndex: 4, newLeg: 3.01, outstanding: 4.09 }),
  opLeg({ cycleIndex: 5, newLeg: -1.40, outstanding: 2.69 }),
  opLeg({ cycleIndex: 6, newLeg: 2.71, outstanding: 5.40 }),
  opLeg({ cycleIndex: 7, newLeg: -1.40, outstanding: 4.00 }),
  opLeg({ cycleIndex: 8, newLeg: -1.40, outstanding: 2.60 }),
  opLeg({ cycleIndex: 9, newLeg: -1.40, outstanding: 1.20 }),
  opLeg({ cycleIndex: 10, newLeg: -1.40, outstanding: -0.20 }),
  opLeg({ cycleIndex: 11, newLeg: -1.40, outstanding: -1.60 }),
];

describe('buildStandingStripToTerm', () => {
  it('rolling holds the whole book flat each month — open carry, no back-conversion', () => {
    const legs = buildStandingStripToTerm(48.98, 12, 'rolling');
    expect(legs).toHaveLength(12);
    for (const l of legs) {
      expect(l.newLeg).toBeCloseTo(48.98, 5);
      expect(l.outstanding).toBeCloseTo(48.98, 5);
      expect(l.settleMonths).toBe(1);
    }
    expect(peakFundingSwapBookM(legs)).toBeCloseTo(48.98, 5);
    // No unwind / buy-back leg — the carry position stays open.
    expect(legs.some(l => l.newLeg < 0)).toBe(false);
  });

  it('strip-to-term accumulates book/T each month up to Book S', () => {
    const legs = buildStandingStripToTerm(48.98, 12, 'stripTerm');
    const slices = legs.filter(l => l.settleMonths > 0);
    expect(slices).toHaveLength(12);
    expect(slices[0]!.newLeg).toBeCloseTo(48.98 / 12, 5);
    expect(slices[0]!.outstanding).toBeCloseTo(48.98 / 12, 5);
    expect(slices[11]!.outstanding).toBeCloseTo(48.98, 5);
    for (let i = 1; i < 12; i++) {
      expect(Math.abs(slices[i]!.outstanding)).toBeGreaterThan(Math.abs(slices[i - 1]!.outstanding));
    }
    expect(peakFundingSwapBookM(legs)).toBeCloseTo(48.98, 5);
  });
});

describe('stripDisplayedSwapFcyM', () => {
  it('is contract level: rolling re-deals the standing, strip-to-term / term show the slice', () => {
    const mid = EUR_OPERATING[6]!;
    expect(stripDisplayedSwapFcyM(mid, 'rolling')).toBeCloseTo(5.40, 5);
    expect(stripDisplayedSwapFcyM(mid, 'stripTerm')).toBeCloseTo(2.71, 5);
    expect(stripDisplayedSwapFcyM(mid, 'term')).toBeCloseTo(2.71, 5);
  });

  it('strip-to-term contract size is a flat slice — the building book is `outstanding`, not this column', () => {
    const legs = buildStandingStripToTerm(48.98, 12, 'stripTerm');
    const contract = legs.map(l => stripDisplayedSwapFcyM(l, 'stripTerm'));
    for (const n of contract) expect(n).toBeCloseTo(48.98 / 12, 5);
    // The accrued book still builds — it just lives in `outstanding`.
    expect(legs[0]!.outstanding).toBeCloseTo(48.98 / 12, 5);
    expect(legs[11]!.outstanding).toBeCloseTo(48.98, 5);
  });
});

describe('hedge-table overlay notional — never Overlay + Book S', () => {
  const eurOverlayFcy = -47.43;
  const eurOverlayUsd = -55.5;
  const eurBookS = 79.36;
  const eurSpotSlice = 3.66;
  const eurSpot = 1.17;

  it('EUR short overlay stays short — Overlay + Book S is the misleading long', () => {
    expect(hedgeOverlayNotionalFcyM(eurOverlayFcy)).toBeCloseTo(-47.43, 2);
    expect(hedgeOverlayNotionalUsdM(eurOverlayUsd)).toBeCloseTo(-55.5, 2);
    expect(eurOverlayFcy + eurBookS).toBeCloseTo(31.93, 2);
    expect(hedgeOverlayNotionalFcyM(eurOverlayFcy)).not.toBeCloseTo(31.93, 2);
    expect(hedgeOverlayNotionalUsdM(eurOverlayUsd) + eurBookS * eurSpot)
      .not.toBeCloseTo(hedgeOverlayNotionalUsdM(eurOverlayUsd), 2);
  });

  it('spot line shows overlay FCY; later legs show the funding-swap slice', () => {
    expect(hedgeLegNotionalFcyM({
      overlayFcyM: eurOverlayFcy, swapFcyM: eurSpotSlice, overlayOnThisLeg: true,
    })).toBeCloseTo(-47.43, 2);
    expect(hedgeLegNotionalFcyM({
      overlayFcyM: eurOverlayFcy, swapFcyM: eurSpotSlice, overlayOnThisLeg: false,
    })).toBeCloseTo(3.66, 2);
    expect(hedgeLegNotionalUsdM({
      overlayUsdM: eurOverlayUsd, swapFcyM: eurSpotSlice, spot: eurSpot,
      overlayOnThisLeg: true,
    })).toBeCloseTo(-55.5, 2);
    expect(hedgeLegNotionalUsdM({
      overlayUsdM: eurOverlayUsd, swapFcyM: eurSpotSlice, spot: eurSpot,
      overlayOnThisLeg: false,
    })).toBeCloseTo(eurSpotSlice * eurSpot, 5);
  });

  it('PLN overlay CFaR keeps the diversifier minus — not |VAR|', () => {
    expect(hedgeOverlayCfarUsdM(-0.035)).toBeCloseTo(-0.035, 8);
    expect(hedgeOverlayCfarUsdM(-0.035)).toBeLessThan(0);
    expect(Math.abs(hedgeOverlayCfarUsdM(-0.035))).toBeCloseTo(0.035, 8);
  });
});

describe('scenarioFundingScheduleFor — swap fill rolling', () => {
  it('builds the funding need monotonically to Book S with 1M rolls — no amplified oscillation', () => {
    const sched = scenarioFundingScheduleFor(EUR_OPERATING, 48.98, 'swap', 'rolling');
    expect(sched).toHaveLength(12);
    expect(sched.every(l => l.newLeg > 0 && l.settleMonths === 1)).toBe(true);
    for (let i = 1; i < sched.length; i++) {
      expect(sched[i]!.outstanding).toBeGreaterThan(sched[i - 1]!.outstanding);
      expect(sched[i]!.outstanding).toBeLessThanOrEqual(48.98 + 1e-6);
    }
    expect(sched[11]!.outstanding).toBeCloseTo(48.98, 5);
    // Slices vary with the operating activity — not a flat book.
    expect(new Set(sched.map(l => l.newLeg.toFixed(4))).size).toBeGreaterThan(1);
    expect(sched[2]!.newLeg).toBeGreaterThan(sched[1]!.newLeg);
  });

  it('a short Book S builds monotonically negative', () => {
    const sched = scenarioFundingScheduleFor(EUR_OPERATING, -48.98, 'swap', 'rolling');
    expect(sched.every(l => l.newLeg < 0)).toBe(true);
    expect(sched[11]!.outstanding).toBeCloseTo(-48.98, 5);
  });

  it('flat Book S standing when there is no operating schedule to shape it', () => {
    const sched = scenarioFundingScheduleFor([], 48.98, 'swap', 'rolling');
    expect(sched.length).toBeGreaterThan(0);
    expect(sched.every(l => Math.abs(l.outstanding - 48.98) < 1e-6)).toBe(true);
  });

  it('does not mix overlay into the funding-swap legs', () => {
    const sched = scenarioFundingScheduleFor(EUR_OPERATING, 48.98, 'swap', 'rolling');
    expect(sched.every(l => Number.isFinite(l.newLeg) && Number.isFinite(l.outstanding))).toBe(true);
    expect(sched.length).toBeGreaterThan(0);
  });
});

describe('scenarioFundingScheduleFor — overlay vs both', () => {
  it('overlay fill keeps the operating programme (funding strip off)', () => {
    const sched = scenarioFundingScheduleFor(EUR_OPERATING, 48.98, 'overlay', 'rolling');
    expect(sched.map(l => l.newLeg)).toEqual(EUR_OPERATING.map(l => l.newLeg));
  });

  it('both fill = operating legs + a flat carry standing (Book S − op peak)', () => {
    const sched = scenarioFundingScheduleFor(EUR_OPERATING, 48.98, 'both', 'rolling');
    expect(peakFundingSwapBookM(sched)).toBeCloseTo(48.98, 5);
    // Operating oscillation preserved, shifted by the flat carry add.
    const carryAdd = 48.98 - 5.40;
    expect(sched[0]!.outstanding).toBeCloseTo(-2.50 + carryAdd, 4);
    expect(sched[6]!.outstanding).toBeCloseTo(5.40 + carryAdd, 4);
    // Not a scaled copy of the operating roll.
    expect(sched[0]!.outstanding).not.toBeCloseTo(-2.50 * (48.98 / 5.40), 1);
  });
});

describe('scenarioFundingScheduleFor — swap fill strip-to-term', () => {
  it('builds monotonically to Book S with varying, same-sign slices — no amplified oscillation', () => {
    const sched = scenarioFundingScheduleFor(EUR_OPERATING, 48.98, 'swap', 'stripTerm');
    expect(sched).toHaveLength(12);
    // Every slice points the same way as Book S — no −36 → +90 swings.
    expect(sched.every(l => l.newLeg > 0)).toBe(true);
    // Outstanding builds monotonically and never overshoots Book S.
    for (let i = 1; i < sched.length; i++) {
      expect(sched[i]!.outstanding).toBeGreaterThan(sched[i - 1]!.outstanding);
      expect(sched[i]!.outstanding).toBeLessThanOrEqual(48.98 + 1e-6);
    }
    expect(sched[11]!.outstanding).toBeCloseTo(48.98, 5);
    // Slices are tilted by operating activity, not all equal.
    expect(new Set(sched.map(l => l.newLeg.toFixed(4))).size).toBeGreaterThan(1);
    // Busy month 2 (|newLeg| 6.38) gets a bigger slice than quiet month 1 (1.40).
    expect(sched[2]!.newLeg).toBeGreaterThan(sched[1]!.newLeg);
  });

  it('a short Book S builds monotonically negative', () => {
    const sched = scenarioFundingScheduleFor(EUR_OPERATING, -48.98, 'swap', 'stripTerm');
    expect(sched.every(l => l.newLeg < 0)).toBe(true);
    expect(sched[11]!.outstanding).toBeCloseTo(-48.98, 5);
  });
});

describe('bothBookScheduleFor', () => {
  it('leaves the operating path alone when Book S already matches the op peak', () => {
    const sched = bothBookScheduleFor(EUR_OPERATING, 5.40, 'rolling');
    expect(sched.map(l => l.newLeg)).toEqual(EUR_OPERATING.map(l => l.newLeg));
  });

  it('rolling adds a flat carry standing — not a scaled operating roll', () => {
    const sched = bothBookScheduleFor(EUR_OPERATING, 48.98, 'rolling');
    expect(peakFundingSwapBookM(sched)).toBeCloseTo(48.98, 5);
    expect(sched[0]!.outstanding).toBeCloseTo(-2.50 + (48.98 - 5.40), 4);
    expect(sched[0]!.outstanding).not.toBeCloseTo(-2.50 * (48.98 / 5.40), 1);
  });

  it('strip-to-term still adds a standing of Book S − op peak', () => {
    const sched = bothBookScheduleFor(EUR_OPERATING, 48.98, 'stripTerm');
    const excess = 48.98 - 5.40;
    expect(sched[0]!.outstanding).toBeCloseTo(-2.50 + excess / 12, 4);
    expect(sched[0]!.newLeg).toBeCloseTo(-2.50 + excess / 12, 4);
  });

  it('strip-to-term both-fill last outstanding sits below Book S when the op peak is mid-path', () => {
    const bookS = 48.98;
    const sched = bothBookScheduleFor(EUR_OPERATING, bookS, 'stripTerm');
    const last = sched[sched.length - 1]!.outstanding;
    const peak = peakFundingSwapBookM(sched);
    // Operating peak is mid-path (5.40 at M7); last operating is −1.60.
    // Carry add is Book S − opPeak, so last = −1.60 + (48.98 − 5.40) = 41.98.
    expect(last).toBeCloseTo(-1.60 + (bookS - 5.40), 4);
    expect(Math.abs(last)).toBeLessThan(Math.abs(bookS) - 0.5);
    expect(Math.abs(peak)).toBeLessThan(Math.abs(bookS) - 0.5);
  });
});

describe('fundingSwapTenorLabel', () => {
  it('spot 1M stays M1', () => {
    expect(fundingSwapTenorLabel({ valueDateMonths: 0, settleMonths: 1 })).toBe('M1');
  });

  it('spot 12M is the 0M-12M window, not 12M far', () => {
    expect(fundingSwapTenorLabel({ valueDateMonths: 0, settleMonths: 12 })).toBe('0M-12M');
  });

  it('fwd-start names the window being started (1M-12M)', () => {
    expect(fundingSwapTenorLabel({ valueDateMonths: 1, settleMonths: 11 })).toBe('1M-12M');
  });

  it('later strip-to-term legs keep the shared far date', () => {
    expect(fundingSwapTenorLabel({ valueDateMonths: 2, settleMonths: 10 })).toBe('2M-12M');
    expect(fundingSwapTenorLabel({ valueDateMonths: 6, settleMonths: 6 })).toBe('6M-12M');
  });

  it('rolling 1M later months stay Mn', () => {
    expect(fundingSwapTenorLabel({ valueDateMonths: 1, settleMonths: 1 })).toBe('M2');
    expect(fundingSwapTenorLabel({ valueDateMonths: 11, settleMonths: 1 })).toBe('M12');
  });

  it('strip-to-term and term standing match Book-table labels', () => {
    expect(
      buildStandingStripToTerm(-10, 12, 'term').map(fundingSwapTenorLabel),
    ).toEqual(['0M-12M']);
    expect(
      buildStandingStripToTerm(-10, 12, 'stripTerm').map(fundingSwapTenorLabel),
    ).toEqual([
      '0M-12M',
      '1M-12M', '2M-12M', '3M-12M', '4M-12M', '5M-12M',
      '6M-12M', '7M-12M', '8M-12M', '9M-12M', '10M-12M',
      'M12',
    ]);
    expect(
      buildStandingStripToTerm(-10, 12, 'rolling').map(fundingSwapTenorLabel),
    ).toEqual([
      'M1', 'M2', 'M3', 'M4', 'M5', 'M6',
      'M7', 'M8', 'M9', 'M10', 'M11', 'M12',
    ]);
  });
});
