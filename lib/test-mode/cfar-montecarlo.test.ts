import { describe, expect, it } from 'vitest';
import {
  computeMonteCarloMismatchCfar,
  type McCfarInput,
} from '@/lib/test-mode/cfar-montecarlo';

/** 12-month EUR book: 1.0M stock, +1.2M in / −0.4M out every month. */
function baseInput(overrides: Partial<McCfarInput> = {}): McCfarInput {
  const T = 12;
  return {
    stockM: 1,
    monthlyInflows: new Array(T).fill(1.2),
    monthlyOutflows: new Array(T).fill(0.4),
    tenureMonths: T,
    spotUsd: 1.08,
    sigmaFxMonthly: 0.025,
    confidencePct: 95,
    forecastUncertainty1m: 0.08,
    hedgeSettleSchedule: [],
    settlementJitterDays: 2,
    flowJitterDays: 5,
    usdRatePctPa: 4.3,
    fcyRatePctPa: 2.15,
    borrowSpreadPctPa: 2.5,
    rateVolPctPa: 0.45,
    paths: 400,
    seed: 12345,
    ...overrides,
  };
}

describe('computeMonteCarloMismatchCfar — cash ledger', () => {
  it('reports ~zero CFaR when nothing is stochastic', () => {
    // No FX vol, no forecast error, no date jitter, no rate vol → every path
    // reproduces the plan ledger exactly, so there is nothing to be at risk.
    const r = computeMonteCarloMismatchCfar(
      baseInput({
        sigmaFxMonthly: 0,
        forecastUncertainty1m: 0,
        settlementJitterDays: 0,
        flowJitterDays: 0,
        rateVolPctPa: 0,
        hedgeSettleSchedule: [{ settleMonths: 6, notionalLocalM: 5 }],
      }),
    );
    expect(r.criticalCashUsdM).toBeLessThan(1e-9);
    expect(r.netCriticalCashUsdM).toBeLessThan(1e-9);
  });

  it('is deterministic for a given seed and varies with it', () => {
    const a = computeMonteCarloMismatchCfar(baseInput());
    const b = computeMonteCarloMismatchCfar(baseInput());
    const c = computeMonteCarloMismatchCfar(baseInput({ seed: 999 }));
    expect(a.criticalCashUsdM).toBe(b.criticalCashUsdM);
    expect(a.criticalCashUsdM).not.toBe(c.criticalCashUsdM);
  });

  it('decomposes the FCY balance additively at every grid point', () => {
    // structural + size + timing = total, exactly — the attribution is nested
    // counterfactuals, so means add by linearity with no residual.
    const r = computeMonteCarloMismatchCfar(
      baseInput({
        hedgeSettleSchedule: [
          { settleMonths: 4, notionalLocalM: 3 },
          { settleMonths: 8, notionalLocalM: 3 },
          { settleMonths: 12, notionalLocalM: 3 },
        ],
      }),
    );
    for (const c of r.components) {
      const parts =
        c.structuralGapLocalM + c.sizeMismatchLocalM + c.timingMismatchLocalM;
      expect(Math.abs(parts - c.mismatchLocalM)).toBeLessThan(1e-9);
    }
  });

  // ── the structural gap is a planned SIZE, priced only through the rate ──
  //
  // A known liquidity gap must not generate risk merely by being large. Its
  // only channel into CFaR is that the rate it is eventually valued at is
  // uncertain, so at zero FX vol it has to contribute exactly nothing.

  /** Bullet at M12: the whole book runs unhedged all year — a ~9.9M known gap. */
  const bigGapBullet = [{ settleMonths: 12, notionalLocalM: 10.6 }];
  /** Monthly strip tracking the accrual — the same book with almost no gap. */
  const smallGapStrip = Array.from({ length: 12 }, (_, i) => ({
    settleMonths: i + 1,
    notionalLocalM: i === 0 ? 1.8 : 0.8,
  }));

  it('gives a purely structural book zero CFaR at zero FX vol', () => {
    const r = computeMonteCarloMismatchCfar(
      baseInput({
        hedgeSettleSchedule: bigGapBullet,
        sigmaFxMonthly: 0,
        forecastUncertainty1m: 0,
        flowJitterDays: 0,
        settlementJitterDays: 0,
        rateVolPctPa: 0,
      }),
    );
    const peakGap = Math.max(...r.components.map(c => Math.abs(c.structuralGapLocalM)));
    expect(peakGap).toBeGreaterThan(5); // the gap is genuinely there
    expect(r.criticalCashUsdM).toBeLessThan(1e-9); // and costs nothing
  });

  it('keeps rate-differential vol out of both gross and the reserve', () => {
    // The structural gap's SIZE is planned, so at zero FX vol there is nothing
    // to revalue and gross stays at exactly zero however volatile the rate
    // differential is.
    const structuralOnly = (rateVolPctPa: number) =>
      computeMonteCarloMismatchCfar(
        baseInput({
          hedgeSettleSchedule: bigGapBullet,
          sigmaFxMonthly: 0,
          forecastUncertainty1m: 0,
          flowJitterDays: 0,
          settlementJitterDays: 0,
          rateVolPctPa,
        }),
      );
    for (const rateVol of [0, 0.45, 2]) {
      expect(structuralOnly(rateVol).criticalCashUsdM).toBeLessThan(1e-9);
    }
    // And with carry floored, rate vol cannot sneak into the reserve either:
    // a purely structural book stays at zero on BOTH curves.
    for (const rateVol of [0, 0.45, 2]) {
      expect(structuralOnly(rateVol).netCriticalCashUsdM).toBeLessThan(1e-9);
    }
    // Interest is still accrued and reported — only kept out of the risk.
    expect(Math.abs(structuralOnly(2).carryMeanUsdM)).toBeGreaterThan(0);
  });

  it('zeroes the structural attribution at zero FX vol even with the other drivers on', () => {
    const r = computeMonteCarloMismatchCfar(
      baseInput({ hedgeSettleSchedule: bigGapBullet, sigmaFxMonthly: 0 }),
    );
    const maxStructural = Math.max(
      ...r.components.map(c => Math.abs(c.structuralFxRiskUsdM)),
    );
    expect(maxStructural).toBeLessThan(1e-9);
    // With the rate frozen there is nothing left for size or timing to cost
    // either: a displaced or short flow is only ever charged its FX move,
    // forced unwind and financing, and the first two vanish at sigma = 0.
    expect(r.criticalCashUsdM).toBeLessThan(0.02);
  });

  it('makes gross CFaR insensitive to structural gap SIZE at zero FX vol', () => {
    const at = (sigmaFxMonthly: number, hedgeSettleSchedule: typeof bigGapBullet) =>
      computeMonteCarloMismatchCfar(
        baseInput({ hedgeSettleSchedule, sigmaFxMonthly }),
      ).criticalCashUsdM;
    // A 9.9M known gap and a ~1M one both cost essentially nothing when the
    // rate cannot move — compared absolutely, since both collapse to ~0 and a
    // ratio between two near-zero numbers says nothing.
    expect(Math.abs(at(0, bigGapBullet) - at(0, smallGapStrip))).toBeLessThan(0.02);
    // Turn the rate back on and the big gap costs materially more, which is
    // the one way its size is allowed to matter.
    expect(at(0.025, bigGapBullet)).toBeGreaterThan(at(0.025, smallGapStrip) * 1.2);
  });

  it('scales the structural attribution with FX vol', () => {
    const structuralAt = (sigmaFxMonthly: number) => {
      const r = computeMonteCarloMismatchCfar(
        baseInput({
          hedgeSettleSchedule: bigGapBullet,
          sigmaFxMonthly,
          forecastUncertainty1m: 0,
          flowJitterDays: 0,
          settlementJitterDays: 0,
          rateVolPctPa: 0,
        }),
      );
      return Math.max(...r.components.map(c => c.structuralFxRiskUsdM));
    };
    expect(structuralAt(0)).toBeLessThan(1e-9);
    expect(structuralAt(0.05)).toBeGreaterThan(structuralAt(0.01) * 3);
  });

  it('scales CFaR roughly linearly with FX vol once other drivers are off', () => {
    // The other drivers are switched off to isolate the FX relationship, not
    // because they would swamp it — they are priced through the rate too.
    const fxOnly = (sigmaFxMonthly: number) =>
      computeMonteCarloMismatchCfar(
        baseInput({
          sigmaFxMonthly,
          forecastUncertainty1m: 0,
          flowJitterDays: 0,
          settlementJitterDays: 0,
          rateVolPctPa: 0,
        }),
      ).criticalCashUsdM;
    const ratio = fxOnly(0.05) / fxOnly(0.01);
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(6.5);
  });

  // ── displaced principal is not a loss ─────────────────────────────────
  //
  // A receivable that is late, or one that lands light against a hedge, has
  // not destroyed its own face value. CFaR charges the FX move over the gap,
  // the forced unwind and the financing — never the principal. These pin the
  // regression where a one-day slip on a 1.2M receivable scored as a 1.3M
  // loss and CFaR came out the same for 1, 5 and 10 days of jitter.

  it('charges a volume shortfall its unwind cost, not its principal', () => {
    const volumeOnly = (sigmaFxMonthly: number) =>
      computeMonteCarloMismatchCfar(
        baseInput({
          sigmaFxMonthly,
          flowJitterDays: 0,
          settlementJitterDays: 0,
          rateVolPctPa: 0,
          forecastUncertainty1m: 0.15,
        }),
      ).criticalCashUsdM;
    // Rate frozen: a 15% forecast miss unwinds at exactly the rate it was
    // hedged at, so it costs nothing — and certainly not 15% of the book.
    expect(volumeOnly(0)).toBeLessThan(0.02);
    // Let the rate move and the same miss starts to cost real money.
    expect(volumeOnly(0.025)).toBeGreaterThan(volumeOnly(0) + 0.05);
  });

  it('scales timing risk with the size of the delay', () => {
    const jitter = (flowJitterDays: number) =>
      computeMonteCarloMismatchCfar(
        baseInput({
          hedgeSettleSchedule: smallGapStrip,
          forecastUncertainty1m: 0,
          settlementJitterDays: 0,
          flowJitterDays,
        }),
      ).netCriticalCashUsdM;
    const [d1, d5, d10] = [jitter(1), jitter(5), jitter(10)];
    // Strictly increasing in the delay. The old engine returned the same
    // number for all three because events snapped to a ~5-day grid.
    expect(d5).toBeGreaterThan(d1);
    expect(d10).toBeGreaterThan(d5);
    // And all of them stay far below the principal of a single monthly flow
    // (1.2M EUR ≈ $1.3M), which is what used to come out.
    expect(d10).toBeLessThan(0.3);
  });

  // ── peak bridge funding: the liquidity companion ──────────────────────
  //
  // Deliberately the mirror image of the cost lines. CFaR excludes the
  // principal of a delayed flow because nothing is lost by waiting; this
  // includes it, because the wait still has to be funded.

  it('reports the funding a payer book genuinely needs', () => {
    const payer = computeMonteCarloMismatchCfar(
      baseInput({
        stockM: 0,
        monthlyInflows: new Array(12).fill(0.2),
        monthlyOutflows: new Array(12).fill(1.2),
        hedgeSettleSchedule: [],
        openingUsdCashM: 0,
      }),
    );
    // 12 months of 1.0M net outflow ≈ $13M has to come from somewhere, and
    // the plan alone already needs most of it.
    const netOutflowUsd = 12 * 1 * 1.08;
    expect(payer.planPeakBridgeFundingUsdM).toBeGreaterThan(netOutflowUsd * 0.9);
    // The stochastic peak sits above the planned one — that difference is
    // the part that is actually at risk.
    expect(payer.peakBridgeFundingUsdM).toBeGreaterThan(
      payer.planPeakBridgeFundingUsdM,
    );
  });

  it('accrues operating flows continuously rather than dropping bullets', () => {
    const r = computeMonteCarloMismatchCfar(
      baseInput({
        stockM: 4,
        monthlyInflows: new Array(12).fill(1.2),
        monthlyOutflows: new Array(12).fill(0),
        tenureMonths: 12,
        hedgeSettleSchedule: [],
        sigmaFxMonthly: 0,
        forecastUncertainty1m: 0,
        flowJitterDays: 0,
        settlementJitterDays: 0,
        rateVolPctPa: 0,
      }),
    );
    const gap = r.components.map(c => c.structuralGapLocalM);
    // Mass conservation first — spreading must not lose or duplicate cash.
    // 4M stock + 14.4M of receipts, plus a little deposit interest on the way.
    expect(gap[gap.length - 1]!).toBeGreaterThan(18.4);
    expect(gap[gap.length - 1]!).toBeLessThan(19.0);
    // And it arrives in slices: the largest single step must be far below the
    // 1.2M a month-end bullet used to land in one go. This is what turns the
    // profile charts from staircases into curves.
    let maxStep = 0;
    for (let i = 1; i < gap.length; i += 1) {
      maxStep = Math.max(maxStep, gap[i]! - gap[i - 1]!);
    }
    expect(maxStep).toBeLessThan(0.4);
  });

  it('grows bridge funding with the length of the delay', () => {
    const need = (flowJitterDays: number) =>
      computeMonteCarloMismatchCfar(
        baseInput({
          hedgeSettleSchedule: smallGapStrip,
          sigmaFxMonthly: 0,
          forecastUncertainty1m: 0,
          settlementJitterDays: 0,
          rateVolPctPa: 0,
          flowJitterDays,
        }),
      ).peakBridgeFundingUsdM;
    // A matched strip is self-funding: settlement proceeds land in USD before
    // the outflows draw on them, so short delays need nothing. Continuous
    // accrual widened that buffer — receipts now arrive through each month
    // instead of all at month-end — so it takes a longer delay to break than
    // it did under the old bullet timing.
    expect(need(0)).toBe(0);
    expect(need(60)).toBe(0);
    // Long enough delays outrun the buffer and do need funding — the very
    // exposure CFaR is silent about.
    expect(need(90)).toBeGreaterThan(0.05);
  });

  it('separates the funding question from the cost question', () => {
    // Same book, delays long enough to need real cash. CFaR stays small
    // because the money arrives; bridge funding does not, because it has to
    // be there in the meantime.
    const r = computeMonteCarloMismatchCfar(
      baseInput({
        hedgeSettleSchedule: smallGapStrip,
        sigmaFxMonthly: 0,
        forecastUncertainty1m: 0,
        settlementJitterDays: 0,
        rateVolPctPa: 0,
        flowJitterDays: 90,
      }),
    );
    // Real cash has to be found, and it costs essentially nothing: the two
    // questions are genuinely separate, which is why both metrics exist.
    expect(r.peakBridgeFundingUsdM).toBeGreaterThan(0.05);
    expect(r.netCriticalCashUsdM).toBeLessThan(0.1);
  });

  it('keeps a hedged book far below an unhedged one and below a plain FX VaR', () => {
    const open = computeMonteCarloMismatchCfar(
      baseInput({ hedgeSettleSchedule: [] }),
    ).criticalCashUsdM;
    const hedged = computeMonteCarloMismatchCfar(
      baseInput({ hedgeSettleSchedule: smallGapStrip }),
    ).criticalCashUsdM;
    expect(hedged).toBeLessThan(open * 0.4);
    // An unhedged book's CFaR is an FX loss on the accrued balance, so it
    // cannot exceed a 95% FX VaR on the terminal exposure by any margin.
    const terminalUsd = (1 + 12 * 0.8) * 1.08;
    expect(open).toBeLessThan(1.645 * 0.025 * Math.sqrt(12) * terminalUsd * 1.15);
  });

  it('cuts CFaR when the book is hedged on a matching schedule', () => {
    const open = computeMonteCarloMismatchCfar(baseInput());
    // Exposure accrues +0.8M/month from 1.0M stock; settle roughly with it.
    const schedule = [3, 6, 9, 12].map(m => ({
      settleMonths: m,
      notionalLocalM: m === 3 ? 1 + 0.8 * 3 : 0.8 * 3,
    }));
    const hedged = computeMonteCarloMismatchCfar(
      baseInput({ hedgeSettleSchedule: schedule }),
    );
    expect(hedged.criticalCashUsdM).toBeLessThan(open.criticalCashUsdM);
  });

  it('charges a forced FCY purchase when the hedge over-delivers', () => {
    // Notional far above anything the book will ever accrue — every leg has to
    // be covered by buying FCY at spot, a realized cash cost.
    const over = computeMonteCarloMismatchCfar(
      baseInput({
        hedgeSettleSchedule: [{ settleMonths: 2, notionalLocalM: 40 }],
      }),
    );
    expect(over.squaringCostMeanUsdM).toBeGreaterThan(0);
    const under = computeMonteCarloMismatchCfar(
      baseInput({ hedgeSettleSchedule: [{ settleMonths: 12, notionalLocalM: 1 }] }),
    );
    expect(over.squaringCostMeanUsdM).toBeGreaterThan(under.squaringCostMeanUsdM);
  });

  it('penalises the net path through the borrow spread on a mismatch excursion', () => {
    // A net-payer book hedged with a monthly strip and funded with USD, so the
    // PLAN never runs either account overdrawn. Only the size/timing mismatch
    // can push a balance negative — and the spread charged on that excursion
    // is genuine risk, so it must widen the net shortfall while gross is
    // untouched. (Spread on a PLANNED overdraft would be planned carry, and is
    // deliberately not measured here: see the structural-carry test above.)
    const payer = (spread: number) =>
      computeMonteCarloMismatchCfar(
        baseInput({
          stockM: 0,
          monthlyInflows: new Array(12).fill(0.2),
          monthlyOutflows: new Array(12).fill(1.2),
          hedgeSettleSchedule: Array.from({ length: 12 }, (_, i) => ({
            settleMonths: i + 1,
            notionalLocalM: -1,
          })),
          openingUsdCashM: 20,
          forecastUncertainty1m: 0.25,
          borrowSpreadPctPa: spread,
        }),
      );
    const cheap = payer(0);
    const dear = payer(8);
    expect(dear.netCriticalCashUsdM).toBeGreaterThan(cheap.netCriticalCashUsdM);
    expect(dear.criticalCashUsdM).toBeCloseTo(cheap.criticalCashUsdM, 10);
  });

  it('widens with date jitter, and stays blind to forecast size by design', () => {
    // The hedge here covers 5M of a ~5.8M accrual, so it never finds the
    // account short and nothing is ever bought back at spot. Under the
    // cost-only rule that leaves a forecast miss with no cash consequence
    // whatsoever, while a DATE shift still moves real money across a real
    // conversion. The size channel is exercised separately, in the attribution
    // suite, on books where a delivery can actually bite.
    const schedule = [{ settleMonths: 6, notionalLocalM: 5 }];
    const quiet = computeMonteCarloMismatchCfar(
      baseInput({
        hedgeSettleSchedule: schedule,
        forecastUncertainty1m: 0,
        flowJitterDays: 0,
        settlementJitterDays: 0,
      }),
    );
    const sizeOnly = computeMonteCarloMismatchCfar(
      baseInput({
        hedgeSettleSchedule: schedule,
        forecastUncertainty1m: 0.2,
        flowJitterDays: 0,
        settlementJitterDays: 0,
      }),
    );
    const datesOnly = computeMonteCarloMismatchCfar(
      baseInput({
        hedgeSettleSchedule: schedule,
        forecastUncertainty1m: 0,
        flowJitterDays: 20,
        settlementJitterDays: 10,
      }),
    );
    expect(sizeOnly.criticalCashUsdM).toBeCloseTo(quiet.criticalCashUsdM, 9);
    expect(datesOnly.criticalCashUsdM).toBeGreaterThan(
      quiet.criticalCashUsdM * 1.02,
    );
  });

  it('keeps the reported peak on the running-max plateau', () => {
    const r = computeMonteCarloMismatchCfar(baseInput());
    const last = r.points[r.points.length - 1]!;
    // p05 carries the loss-negative convention, so |p05| at the final point is
    // the headline gross CFaR.
    expect(Math.abs(last.p05)).toBeCloseTo(r.criticalCashUsdM, 9);
    expect(r.grossPeakMonth).toBeGreaterThan(0);
  });

  it('releases the live line when flows net out but holds the running max', () => {
    // 3.0M lands, an equal 3.0M leaves ~12 days later, repeatedly. Exposure is
    // zero most of the time and nothing is ever converted, so at those instants
    // the book carries no risk at all — while the high-water mark must remember
    // every pulse it lived through.
    const r = computeMonteCarloMismatchCfar(
      baseInput({
        stockM: 0,
        monthlyInflows: [3, 0, 3, 0, 3, 0, 3, 0],
        monthlyOutflows: [0, 3, 0, 3, 0, 3, 0, 3],
        tenureMonths: 8,
        hedgeSettleSchedule: [],
        forecastUncertainty1m: 0,
        flowJitterDays: 0,
        settlementJitterDays: 0,
      }),
    );
    const closed = r.points.filter(
      (p, i) => p.t > 1.3 && Math.abs(r.components[i]!.mismatchLocalM) < 0.05,
    );
    const open = r.points.filter(
      (_, i) => Math.abs(r.components[i]!.mismatchLocalM) > 1,
    );
    expect(closed.length).toBeGreaterThan(5);
    expect(open.length).toBeGreaterThan(5);
    const rawAt = (i: number) => Math.abs(r.components[i]!.rawGrossUsdM);
    for (let i = 0; i < r.points.length; i += 1) {
      const flat = Math.abs(r.components[i]!.mismatchLocalM) < 0.05;
      if (r.points[i]!.t > 1.3 && flat) expect(rawAt(i)).toBeLessThan(0.005);
      // Exposure now RAMPS rather than stepping, so a point that has only just
      // crossed 1M has carried that exposure for a fraction of the time an
      // instant bullet would have. The separation that matters still holds by
      // a wide margin: closed reads under $5K, open over $20K.
      if (Math.abs(r.components[i]!.mismatchLocalM) > 1) {
        expect(rawAt(i)).toBeGreaterThan(0.02);
      }
    }
    // The ratchet only ever climbs, including across the closed stretches.
    for (let i = 1; i < r.points.length; i += 1) {
      expect(r.points[i]!.p05).toBeLessThanOrEqual(r.points[i - 1]!.p05 + 1e-9);
    }
  });

  it('keeps a realized unwind on the live line after settlement', () => {
    // Hedged 4M at a contracted strike, but the flows are uncertain, so paths
    // that come in light must buy FCY at spot to honour delivery. That loss is
    // realized in USD and cannot release the way a mark does.
    const settled = (uncertainty: number) => {
      const r = computeMonteCarloMismatchCfar(
        baseInput({
          stockM: 0,
          monthlyInflows: [1, 1, 1, 1, 0, 0, 0, 0],
          monthlyOutflows: [0, 0, 0, 0, 0, 0, 0, 0],
          tenureMonths: 8,
          hedgeSettleSchedule: [{ settleMonths: 4, notionalLocalM: 4, strikeUsd: 1.08 }],
          forecastUncertainty1m: uncertainty,
          flowJitterDays: 0,
          settlementJitterDays: 0,
        }),
      );
      const cs = r.components;
      const peakLive = Math.max(...cs.map(c => Math.abs(c.rawGrossUsdM)));
      return { tail: Math.abs(cs[cs.length - 1]!.rawGrossUsdM), peakLive };
    };
    // A clean hedge settles at the rate the plan also assumed: nothing deviated,
    // so the live line comes all the way back down.
    expect(settled(0).tail).toBeLessThan(0.005);
    // With shortfalls the unwind is realized, so the tail stays lifted — but
    // still far below the pre-settlement mark, which did release.
    const shortfall = settled(0.15);
    expect(shortfall.tail).toBeGreaterThan(0.005);
    expect(shortfall.tail).toBeLessThan(shortfall.peakLive * 0.5);
  });

  describe('net against the carry buffer', () => {
    it('collapses onto gross when there is no carry at all', () => {
      // Zero every rate and the buffer vanishes, so the reserve is just the
      // drawdown. Exact equality pins that the two are the same running max
      // over the same paths.
      const r = computeMonteCarloMismatchCfar(
        baseInput({
          hedgeSettleSchedule: [{ settleMonths: 6, notionalLocalM: 5 }],
          usdRatePctPa: 0,
          fcyRatePctPa: 0,
          borrowSpreadPctPa: 0,
          rateVolPctPa: 0,
        }),
      );
      expect(r.carryMeanUsdM).toBeCloseTo(0, 12);
      expect(r.netCriticalCashUsdM).toBeCloseTo(r.criticalCashUsdM, 12);
      // With no carry the net line IS the gross band and the reserve is its
      // mirror — net = gross + carry with carry pinned at zero.
      for (let i = 0; i < r.points.length; i += 1) {
        expect(r.points[i]!.netP05).toBeCloseTo(r.points[i]!.p05, 12);
        expect(r.components[i]!.reserveUsdM).toBeCloseTo(-r.points[i]!.p05, 12);
      }
    });

    it('keeps the net line as smooth as the gross line it nets against', () => {
      // Both are running maxima under the hood, so neither may jitter. A
      // point-in-time net would fail this badly — it swings on every flow.
      const r = computeMonteCarloMismatchCfar(
        baseInput({
          stockM: 4,
          monthlyInflows: Array(12).fill(1.2),
          monthlyOutflows: Array(12).fill(0),
          tenureMonths: 12,
          sigmaFxMonthly: 0.03,
          forecastUncertainty1m: 0.3,
          hedgeSettleSchedule: [
            { settleMonths: 3.5, notionalLocalM: 7.8 },
            { settleMonths: 7.3, notionalLocalM: 4.1 },
          ],
        }),
      );
      // Total variation against the two references: gross is monotone, so its
      // TV is the floor, and the point-in-time shortfall is the sawtooth this
      // replaced. Net has to sit next to the former, nowhere near the latter.
      const tv = (f: (i: number) => number) => {
        let v = 0;
        for (let i = 1; i < r.points.length; i += 1) v += Math.abs(f(i) - f(i - 1));
        return v;
      };
      const netTv = tv(i => r.points[i]!.netP05);
      const grossTv = tv(i => r.points[i]!.p05);
      const sawTv = tv(i => -r.components[i]!.rawGrossUsdM);
      expect(netTv).toBeLessThan(grossTv * 1.35);
      expect(netTv).toBeLessThan(sawTv * 0.6);
      // And it really is gross plus carry, not a separate shape — the two
      // differ only by the carry/drawdown correlation the per-path netting
      // picks up.
      const last = r.points[r.points.length - 1]!;
      expect(last.netP05).toBeCloseTo(last.p05 + last.carryUsdM, 1);
    });

    it('reports a reserve that only ever grows, and matches its own curve', () => {
      const r = computeMonteCarloMismatchCfar(
        baseInput({ hedgeSettleSchedule: [{ settleMonths: 6, notionalLocalM: 5 }] }),
      );
      // Running max per path survives percentiling, so the reserve is
      // monotone and never negative.
      for (let i = 1; i < r.components.length; i += 1) {
        expect(r.components[i]!.reserveUsdM).toBeGreaterThanOrEqual(
          r.components[i - 1]!.reserveUsdM - 1e-9,
        );
      }
      for (const c of r.components) expect(c.reserveUsdM).toBeGreaterThanOrEqual(0);
      const worst = Math.max(0, ...r.components.map(c => c.reserveUsdM));
      expect(r.netCriticalCashUsdM).toBeCloseTo(worst, 9);
    });

    it('settles on the carry P&L when there is no risk to net against', () => {
      // No FX vol and no forecast error: the drawdown is zero throughout, so
      // gross + carry is just carry. Rate vol has to go too — the plotted line
      // is an adverse percentile while carryUsdM is the mean, so any dispersion
      // in carry itself separates the two.
      const quiet = (rateVolPctPa: number) =>
        computeMonteCarloMismatchCfar(
          baseInput({
            stockM: 4,
            monthlyInflows: Array(12).fill(1.2),
            monthlyOutflows: Array(12).fill(0),
            tenureMonths: 12,
            sigmaFxMonthly: 0,
            forecastUncertainty1m: 0,
            flowJitterDays: 0,
            settlementJitterDays: 0,
            rateVolPctPa,
            hedgeSettleSchedule: [{ settleMonths: 6, notionalLocalM: 8 }],
          }),
        );
      const r = quiet(0);
      const last = r.points[r.points.length - 1]!;
      expect(last.carryUsdM).toBeGreaterThan(0.05);
      expect(last.netP05).toBeGreaterThan(0);
      expect(last.netP05).toBeCloseTo(last.carryUsdM, 6);
      // Rising with the carry, and the reserve stays at zero throughout
      // because carry was never behind.
      expect(last.netP05).toBeGreaterThan(r.points[2]!.netP05);
      expect(r.netCriticalCashUsdM).toBeLessThan(1e-9);
      // Put rate vol back and the line drops below mean carry without any FX
      // risk at all: uncertain interest is itself a reason to hold cash.
      const noisyLast = quiet(1.5).points[r.points.length - 1]!;
      expect(noisyLast.netP05).toBeLessThan(last.netP05 - 0.02);
    });

    it('never reports a reserve shallower than the curve drawn against it', () => {
      // The chart puts the headline Net CFaR on a floor line beneath the
      // plotted net curve, and tells the reader it may sit deeper than the
      // curve's own trough. That story only holds one way round: a floor
      // drawn INSIDE the curve would just look broken. The reserve takes each
      // path's running-max shortfall, the curve takes the shortfall at that
      // instant, so the reserve can only ever be the deeper of the two.
      const depth = (r: ReturnType<typeof computeMonteCarloMismatchCfar>) =>
        -Math.min(...r.points.map(p => p.netP05));

      const earning = computeMonteCarloMismatchCfar(
        baseInput({
          hedgeSettleSchedule: [{ settleMonths: 6, notionalLocalM: 5 }],
          paths: 1500,
        }),
      );
      expect(earning.carryMeanUsdM).toBeGreaterThan(0);
      expect(earning.netCriticalCashUsdM).toBeGreaterThan(depth(earning));

      // With no carry, or a book that only pays it, nothing ever recovers, so
      // the running max and the instant coincide and the floor lands exactly
      // on the trough.
      const noCarry = computeMonteCarloMismatchCfar(
        baseInput({
          hedgeSettleSchedule: [{ settleMonths: 6, notionalLocalM: 5 }],
          usdRatePctPa: 0,
          fcyRatePctPa: 0,
          borrowSpreadPctPa: 0,
          rateVolPctPa: 0,
        }),
      );
      expect(noCarry.netCriticalCashUsdM).toBeCloseTo(depth(noCarry), 9);

      const payer = computeMonteCarloMismatchCfar(
        baseInput({
          stockM: 0,
          monthlyInflows: new Array(12).fill(0),
          monthlyOutflows: new Array(12).fill(1.2),
          hedgeSettleSchedule: [{ settleMonths: 6, notionalLocalM: -6 }],
        }),
      );
      expect(payer.carryMeanUsdM).toBeLessThanOrEqual(0);
      expect(payer.netCriticalCashUsdM).toBeCloseTo(depth(payer), 9);
    });

    it('lets rate vol move the USD leg, not only the FCY one', () => {
      // Nothing but USD cash: the FCY account is empty the whole horizon, so
      // the differential shock has nothing to act on and every dollar of carry
      // variance has to come from the USD curve itself. Modelling rate vol as
      // a differential shock alone froze that leg, which quietly claimed a
      // book funding itself in dollars had certain interest.
      const usdOnly = (rateVolPctPa: number) =>
        computeMonteCarloMismatchCfar(
          baseInput({
            stockM: 0,
            monthlyInflows: Array(12).fill(0),
            monthlyOutflows: Array(12).fill(0),
            tenureMonths: 12,
            openingUsdCashM: 20,
            hedgeSettleSchedule: [],
            sigmaFxMonthly: 0,
            forecastUncertainty1m: 0,
            flowJitterDays: 0,
            settlementJitterDays: 0,
            rateVolPctPa,
          }),
        );
      const calm = usdOnly(0);
      const choppy = usdOnly(1.5);
      expect(calm.carryStdUsdM).toBeCloseTo(0, 9);
      expect(choppy.carryStdUsdM).toBeGreaterThan(0.02);
      // Carry moves; gross cannot, since equity is measured with accrual off.
      expect(choppy.criticalCashUsdM).toBeCloseTo(calm.criticalCashUsdM, 9);
    });

    it('prices carry as a random variable, not as its mean', () => {
      const withRateVol = (rateVolPctPa: number) =>
        computeMonteCarloMismatchCfar(
          baseInput({
            stockM: 8,
            monthlyInflows: Array(12).fill(1),
            monthlyOutflows: Array(12).fill(0),
            tenureMonths: 12,
            hedgeSettleSchedule: [],
            rateVolPctPa,
            forecastUncertainty1m: 0.1,
          }),
        );
      const calm = withRateVol(0);
      const choppy = withRateVol(4);
      // Rate-differential vol makes each path's accrual genuinely uncertain.
      expect(choppy.carryStdUsdM).toBeGreaterThan(calm.carryStdUsdM * 4);
      // Gross knows nothing about rates, so it must be untouched.
      expect(choppy.criticalCashUsdM).toBeCloseTo(calm.criticalCashUsdM, 9);
      // The property that actually matters: the reserve is NOT the shortcut
      // of subtracting mean carry from the gross percentile. It comes out
      // strictly higher, because carry is paired to the drawdown in time and
      // per path — the binding moment is early, when little carry has
      // accrued, so crediting the full-horizon mean would under-reserve.
      for (const r of [calm, choppy]) {
        const naive = Math.max(0, r.criticalCashUsdM - r.carryMeanUsdM);
        expect(r.netCriticalCashUsdM).toBeGreaterThan(naive);
      }
    });

    it('never lets a paid carry create a reserve of its own', () => {
      // Short a higher-rate currency: holding the position costs money. That
      // cost is known at trade time, so it is P&L and must not be dressed up
      // as a confidence-level reserve. Carry is floored, so the reserve can
      // never exceed the drawdown and the borrow spread cannot inflate it.
      const payer = (borrowSpreadPctPa: number) =>
        computeMonteCarloMismatchCfar(
          baseInput({
            stockM: 0,
            monthlyInflows: Array(12).fill(0),
            monthlyOutflows: Array(12).fill(1.2),
            tenureMonths: 12,
            usdRatePctPa: 4.3,
            fcyRatePctPa: 5.75,
            rateVolPctPa: 1.2,
            borrowSpreadPctPa,
            hedgeSettleSchedule: [{ settleMonths: 6, notionalLocalM: 10 }],
          }),
        );
      const r = payer(2.5);
      expect(r.carryMeanUsdM).toBeLessThan(0);
      expect(r.netCriticalCashUsdM).toBeLessThanOrEqual(r.criticalCashUsdM + 1e-9);
      // Widening the spread deepens the bleed — visible in carry, invisible
      // in the reserve, which is the whole point.
      const wide = payer(6);
      expect(wide.carryMeanUsdM).toBeLessThan(r.carryMeanUsdM);
      expect(wide.netCriticalCashUsdM).toBeCloseTo(r.netCriticalCashUsdM, 9);
      expect(wide.criticalCashUsdM).toBeCloseTo(r.criticalCashUsdM, 9);
    });

    it('reports no reserve at all when nothing is random', () => {
      // The case that exposed this: a payer book with every stochastic driver
      // switched off still asked for a "95% reserve" equal to its carry bill.
      const r = computeMonteCarloMismatchCfar(
        baseInput({
          stockM: -1.8,
          monthlyInflows: Array(12).fill(0),
          monthlyOutflows: Array(12).fill(1.8),
          tenureMonths: 12,
          spotUsd: 0.25,
          sigmaFxMonthly: 0,
          forecastUncertainty1m: 0,
          rateVolPctPa: 0,
          flowJitterDays: 0,
          settlementJitterDays: 0,
          usdRatePctPa: 4.3,
          fcyRatePctPa: 5.75,
          hedgeSettleSchedule: [{ settleMonths: 11, notionalLocalM: 23 }],
        }),
      );
      // Carry is a real, sizeable cost with literally zero variance...
      expect(r.carryMeanUsdM).toBeLessThan(-0.05);
      expect(r.carryStdUsdM).toBeCloseTo(0, 9);
      // ...and none of it is risk.
      expect(r.criticalCashUsdM).toBeLessThan(1e-9);
      expect(r.netCriticalCashUsdM).toBeLessThan(1e-9);
    });

    it('credits carry only as it accrues, not as a lump', () => {
      // A schedule paying its whole carry in the final month must not offset a
      // drawdown that happens in month one.
      const legs = [{ settleMonths: 6, notionalLocalM: 5 }];
      const late = computeMonteCarloMismatchCfar(
        baseInput({
          hedgeSettleSchedule: legs,
          hedgeCarryScheduleUsdM: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        }),
      );
      const even = computeMonteCarloMismatchCfar(
        baseInput({
          hedgeSettleSchedule: legs,
          hedgeCarryScheduleUsdM: Array.from({ length: 12 }, (_, i) => ((i + 1) * 2) / 12),
        }),
      );
      // Same total carry, but the evenly-accrued one is there when the early
      // drawdowns happen, so it covers strictly more of them.
      expect(even.netCriticalCashUsdM).toBeLessThan(late.netCriticalCashUsdM);
    });

    it('goes to zero once carry outruns every drawdown', () => {
      const r = computeMonteCarloMismatchCfar(
        baseInput({
          hedgeSettleSchedule: [{ settleMonths: 6, notionalLocalM: 5 }],
          hedgeCarryScheduleUsdM: Array.from({ length: 12 }, () => 500),
        }),
      );
      expect(r.netCriticalCashUsdM).toBe(0);
      // The gross drawdown is untouched by the buffer.
      expect(r.criticalCashUsdM).toBeGreaterThan(0);
    });

  });

  describe('unplanned USD funding', () => {
    const receiver = (unc: number, sigma: number, hedged: boolean) =>
      computeMonteCarloMismatchCfar(
        baseInput({
          stockM: 0,
          monthlyInflows: Array(12).fill(1),
          monthlyOutflows: Array(12).fill(0),
          tenureMonths: 12,
          hedgeSettleSchedule: hedged
            ? Array.from({ length: 4 }, (_, i) => ({
                settleMonths: (i + 1) * 3,
                notionalLocalM: 3,
              }))
            : [],
          sigmaFxMonthly: sigma,
          forecastUncertainty1m: unc,
          flowJitterDays: 0,
          settlementJitterDays: 0,
        }),
      );

    it('survives zero FX vol and scales with the forecast miss', () => {
      // The gap still has to be BOUGHT when vol is off — zero vol only means
      // the price is known up front, not that the currency is free. This is
      // the case where CFaR correctly reports ~0 and funding must not.
      const flat = receiver(0, 0, true);
      const mid = receiver(0.3, 0, true);
      const wide = receiver(0.5, 0, true);
      expect(flat.peakUnplannedUsdFundingUsdM).toBeLessThan(0.01);
      expect(mid.peakUnplannedUsdFundingUsdM).toBeGreaterThan(1);
      expect(wide.peakUnplannedUsdFundingUsdM).toBeGreaterThan(
        mid.peakUnplannedUsdFundingUsdM * 1.3,
      );
      // ...while the cost line stays flat, because at σ=0 spot = forward =
      // strike and covering the shortfall costs exactly nothing.
      expect(mid.criticalCashUsdM).toBeLessThan(0.01);
      expect(wide.criticalCashUsdM).toBeLessThan(0.01);
    });

    it('accrues over the horizon rather than jumping to its peak', () => {
      const r = receiver(0.3, 0, true);
      const at = (t: number) =>
        r.components.reduce((a, c) => (Math.abs(c.t - t) < Math.abs(a.t - t) ? c : a))
          .unplannedUsdFundingUsdM;
      expect(at(3)).toBeGreaterThan(at(1) * 1.2);
      expect(at(12)).toBeGreaterThan(at(6) * 1.2);
    });

    it('is not cured by hedging, unlike the cost line', () => {
      // A forward locks the RATE on the gap; it does not conjure the currency
      // the forecast said would arrive. Cost collapses, funding does not.
      const open = receiver(0.3, 0.025, false);
      const hedged = receiver(0.3, 0.025, true);
      expect(hedged.criticalCashUsdM).toBeLessThan(open.criticalCashUsdM * 0.5);
      expect(hedged.peakUnplannedUsdFundingUsdM).toBeGreaterThan(
        hedged.criticalCashUsdM * 3,
      );
    });

    it('excludes the plan and reduces to CFaR when nothing is displaced', () => {
      // No size or timing mismatch: the only gap left is FX revaluation, so
      // there is no principal to net out and funding must equal the cost.
      const r = receiver(0, 0.025, true);
      expect(r.peakUnplannedUsdFundingUsdM).toBeCloseTo(r.criticalCashUsdM, 6);
    });
  });

  describe('size and timing attribution need a conversion to bite', () => {
    const book = (hedgeSettleSchedule: McCfarInput['hedgeSettleSchedule']) =>
      computeMonteCarloMismatchCfar(
        baseInput({
          stockM: 4,
          monthlyInflows: Array(12).fill(1.2),
          monthlyOutflows: Array(12).fill(0),
          tenureMonths: 12,
          sigmaFxMonthly: 0.03,
          forecastUncertainty1m: 0.3,
          flowJitterDays: 20,
          settlementJitterDays: 10,
          hedgeSettleSchedule,
        }),
      );

    it('reads exactly zero on an unhedged book, however loose the forecast', () => {
      // Nothing is ever converted, so a forecast miss or a late flow only
      // changes how much currency is sitting there — and the ledger credits
      // that principal back. Zero COST is the right answer under the
      // cost-only rule, even though the book is plainly risky.
      const r = book([]);
      for (const c of r.components) {
        expect(c.sizeFxRiskUsdM).toBeCloseTo(0, 12);
        expect(c.timingFxRiskUsdM).toBeCloseTo(0, 12);
      }
      // The risk has not vanished — it is all revaluation, and it all lands
      // in the structural leg.
      expect(r.criticalCashUsdM).toBeGreaterThan(0.5);
      const struct = Math.max(...r.components.map(c => c.structuralFxRiskUsdM));
      expect(struct).toBeGreaterThan(0.5);
    });

    it('leaves gross CFaR untouched by forecast quality when nothing converts', () => {
      // The strong form of the cost-only rule, and the claim chart ⑤ makes to
      // the user: on an unhedged book the credit-back cancels the revaluation
      // of the miss on every path at every instant, so gross is not merely
      // insensitive to forecast error, it is bit-for-bit identical.
      const gross = [0, 0.15, 0.3, 0.6].map(
        u =>
          computeMonteCarloMismatchCfar(
            baseInput({
              stockM: 4,
              monthlyInflows: Array(12).fill(1.2),
              monthlyOutflows: Array(12).fill(0),
              tenureMonths: 12,
              sigmaFxMonthly: 0.03,
              forecastUncertainty1m: u,
              hedgeSettleSchedule: [],
            }),
          ).criticalCashUsdM,
      );
      for (const g of gross) expect(g).toBeCloseTo(gross[0]!, 12);
      // Guard the test itself: the book has to be risky for this to mean
      // anything, otherwise a zero would pass trivially.
      expect(gross[0]!).toBeGreaterThan(0.5);
    });

    it('comes alive once a hedge forces a delivery', () => {
      const r = book([{ settleMonths: 3.5, notionalLocalM: 8, strikeUsd: 1.08 }]);
      // 10-day settlement jitter can pull the leg a month early on a tail
      // path, so the "nothing converted yet" window has to clear that.
      const before = r.components.filter(c => c.t < 2);
      const after = r.components.filter(c => c.t > 4);
      for (const c of before) {
        expect(c.sizeFxRiskUsdM).toBeCloseTo(0, 12);
        expect(c.timingFxRiskUsdM).toBeCloseTo(0, 12);
      }
      expect(Math.max(...after.map(c => Math.abs(c.sizeFxRiskUsdM)))).toBeGreaterThan(0.005);
      expect(Math.max(...after.map(c => Math.abs(c.timingFxRiskUsdM)))).toBeGreaterThan(0.005);
    });

    it('does not let the separately-percentiled parts sum to the whole', () => {
      // Guards the chart copy: the parts telescope per path but their
      // percentiles do not add, so anything claiming ④+⑤+⑥ = ⑦ is wrong.
      const r = book([{ settleMonths: 3.5, notionalLocalM: 8, strikeUsd: 1.08 }]);
      const last = r.components[r.components.length - 1]!;
      const sum =
        last.structuralFxRiskUsdM + last.sizeFxRiskUsdM + last.timingFxRiskUsdM;
      expect(sum).toBeGreaterThan(last.rawGrossUsdM);
    });
  });

  it('keeps the point-in-time drawdown clear of carry so $0 means square', () => {
    // 2.0M in at M2, 2.0M out at M4, unhedged. The book is square outside that
    // window, and a fat carry schedule must not lift the reading off zero
    // there — netting carry in would have it showing the running carry total
    // against no exposure at all.
    const r = computeMonteCarloMismatchCfar(
      baseInput({
        stockM: 0,
        monthlyInflows: [0, 0, 2, 0, 0, 0, 0, 0],
        monthlyOutflows: [0, 0, 0, 0, 2, 0, 0, 0],
        tenureMonths: 8,
        hedgeSettleSchedule: [],
        hedgeCarryScheduleUsdM: Array.from({ length: 8 }, (_, i) => 0.04 * (i + 1)),
        forecastUncertainty1m: 0,
        flowJitterDays: 0,
        settlementJitterDays: 0,
      }),
    );
    const squareTail = r.components.filter(c => c.t >= 5);
    expect(squareTail.length).toBeGreaterThan(3);
    for (const c of squareTail) expect(Math.abs(c.rawGrossUsdM)).toBeLessThan(0.005);
    // The carry buffer is genuinely large over that stretch, so this only
    // holds because the drawdown reading ignores it.
    expect(squareTail[squareTail.length - 1]!.carryMeanUsdM).toBeGreaterThan(0.2);
  });

  it('never reports a non-finite point', () => {
    const r = computeMonteCarloMismatchCfar(
      baseInput({ hedgeSettleSchedule: [{ settleMonths: 6, notionalLocalM: 5 }] }),
    );
    for (const c of r.components) {
      expect(Number.isFinite(c.rawGrossUsdM)).toBe(true);
      expect(Number.isFinite(c.rawNetUsdM)).toBe(true);
    }
  });
});
