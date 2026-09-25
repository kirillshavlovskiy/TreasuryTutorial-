import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EURUSD_MARKET_RATES,
  emptyMarketRatesForCcy,
  swapPointsToPriceDelta,
} from '@/lib/fx-market-rates';
import {
  canConfirmSimTicket,
  payoutAtRemainingLife,
  sampleOptionMarketCharts,
  simulateTicketPrice,
} from '@/lib/test-mode/sim-ticket-price';

describe('simulateTicketPrice', () => {
  it('rebases the last EURUSD curve onto a newer live spot', () => {
    const bundle = DEFAULT_EURUSD_MARKET_RATES;
    const seed = simulateTicketPrice({
      ccy: 'EUR',
      instrument: 'forward',
      tenorMonths: 12,
      amountLocalM: 21.6,
      bundle,
    });
    expect(seed.quote.fxSpot).toBeCloseTo(bundle.spot!.mid, 5);
    expect(seed.blend.curveSource).toBe('swap-points');
    expect(seed.blend.spotSource).toBe('bundle');

    const liveMid = bundle.spot!.mid + 0.01;
    const live = simulateTicketPrice({
      ccy: 'EUR',
      instrument: 'forward',
      tenorMonths: 12,
      amountLocalM: 21.6,
      bundle,
      liveSpot: { bid: liveMid - 0.0001, ask: liveMid + 0.0001, mid: liveMid },
    });
    expect(live.blend.spotSource).toBe('live');
    expect(live.quote.fxOutright! - seed.quote.fxOutright!).toBeCloseTo(0.01, 5);
  });

  it('applies last-download swap points to live spot (sell = ask)', () => {
    const bundle = DEFAULT_EURUSD_MARKET_RATES;
    const oneY = bundle.deposits.find(d => d.tenor === '1Y');
    expect(oneY?.swapPoints?.ask).toBeTruthy();
    const priced = simulateTicketPrice({
      ccy: 'EUR',
      instrument: 'forward',
      tenorMonths: 12,
      amountLocalM: 10,
      bundle,
    });
    const expected =
      bundle.spot!.mid + swapPointsToPriceDelta(oneY!.swapPoints!.ask!, 'EUR');
    expect(priced.quote.fxOutright).toBeCloseTo(expected, 6);
    expect(priced.blend.quoteSide).toBe('ask');
  });

  it('applies mid swap points when quoteSide is mid', () => {
    const bundle = DEFAULT_EURUSD_MARKET_RATES;
    const oneY = bundle.deposits.find(d => d.tenor === '1Y');
    const midPts = (oneY!.swapPoints!.bid! + oneY!.swapPoints!.ask!) / 2;
    const priced = simulateTicketPrice({
      ccy: 'EUR',
      instrument: 'forward',
      tenorMonths: 12,
      amountLocalM: 10,
      bundle,
      quoteSide: 'mid',
    });
    const expected = bundle.spot!.mid + swapPointsToPriceDelta(midPts, 'EUR');
    expect(priced.quote.fxOutright).toBeCloseTo(expected, 6);
    expect(priced.blend.quoteSide).toBe('mid');
    expect(priced.blend.curvePoints).toBeCloseTo(midPts, 6);
  });

  it('reads the last vol surface for an option and stamps premium', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('JPY'),
      spot: { bid: 147.8, ask: 147.84, mid: 147.82 },
      parameters: {
        ipaVolSurface: {
          surfaceTag: 'FxVol-USDJPY',
          fxCrossCode: 'USDJPY',
          xLabels: ['1M', '1Y'],
          yLabels: ['25P', 'ATM', '25C'],
          values: [
            [0.09, 0.11],
            [0.07, 0.08],
            [0.085, 0.095],
          ],
          errorMessage: '',
          pulledAt: '2026-08-30T12:00:00Z',
          xAxis: 'Tenor',
          yAxis: 'Delta',
        },
      },
    };
    const priced = simulateTicketPrice({
      ccy: 'JPY',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: '25d',
      amountLocalM: 500,
      bundle,
    });
    expect(priced.blend.volSource).toBe('surface');
    expect(priced.blend.pair).toBe('USDJPY');
    expect(priced.quote.impliedVolPercent).toBeCloseTo(11, 5);
    expect(priced.quote.premiumUsd).toBeGreaterThan(0);
    expect(priced.quote.fxSpot).toBeCloseTo(147.82, 5);
  });

  it('blocks confirm until a quote exists unless book-unpriced', () => {
    expect(canConfirmSimTicket(null, false)).toBe(false);
    expect(canConfirmSimTicket(null, true)).toBe(true);
    expect(canConfirmSimTicket({
      strike: null,
      strikeInput: 'ATMF',
      premiumUsd: null,
      premiumPercent: null,
      fxSpot: 1.15,
      fxOutright: 1.16,
      atmVolPercent: null,
      impliedVolPercent: null,
      deltaPercent: null,
    }, false)).toBe(true);
  });

  it('samples IPA vol vs strike (put wing left of ATM) and a long-put payout', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('JPY'),
      spot: { bid: 147.8, ask: 147.84, mid: 147.82 },
      parameters: {
        ipaVolSurface: {
          surfaceTag: 'FxVol-USDJPY',
          fxCrossCode: 'USDJPY',
          xLabels: ['1M', '1Y'],
          yLabels: ['25P', 'ATM', '25C'],
          values: [
            [0.09, 0.11],
            [0.07, 0.08],
            [0.085, 0.095],
          ],
          errorMessage: '',
          pulledAt: '2026-08-30T12:00:00Z',
          xAxis: 'Tenor',
          yAxis: 'Delta',
        },
      },
    };
    const { skew, payout } = sampleOptionMarketCharts({
      ccy: 'JPY',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: '25d',
      amountLocalM: 500,
      bundle,
    });
    expect(skew.smile).toBe(true);
    expect(skew.volSource).toBe('surface');
    const put25 = skew.points.find(p => /25P/i.test(p.label));
    const atm = skew.points.find(p => /atm/i.test(p.label));
    const call25 = skew.points.find(p => /25C/i.test(p.label));
    expect(put25?.volPercent).toBeCloseTo(11, 5);
    expect(atm?.volPercent).toBeCloseTo(8, 5);
    expect(call25?.volPercent).toBeCloseTo(9.5, 5);
    expect(put25!.strike).toBeLessThan(atm!.strike);
    expect(call25!.strike).toBeGreaterThan(atm!.strike);
    expect(payout).not.toBeNull();
    expect(payout!.put).toBe(true);
    expect(payout!.longOption).toBe(true);
    const atSpot = payout!.points.reduce((best, p) =>
      Math.abs(p.spot - payout!.spot) < Math.abs(best.spot - payout!.spot) ? p : best,
    payout!.points[0]!);
    expect(atSpot.pnlUsdM).toBeLessThan(0);
    const deepItm = payout!.points[0]!;
    expect(deepItm.spot).toBeLessThan(payout!.strike);
    expect(deepItm.pnlUsdM).toBeGreaterThan(atSpot.pnlUsdM);
    const farOtm = payout!.points.at(-1)!;
    expect(payout!.deltaVolPercent).toBeGreaterThan(0);
    expect(deepItm.deltaLocalM).toBeLessThan(atSpot.deltaLocalM);
    expect(atSpot.deltaLocalM).toBeLessThan(farOtm.deltaLocalM);
    expect(deepItm.deltaLocalM).toBeLessThan(-100);
    expect(farOtm.deltaLocalM).toBeGreaterThan(-80);
    expect(Math.abs(deepItm.deltaUsdM)).toBeGreaterThan(0);
  });

  it('keeps the payout spot window fixed so K slides against 0 P&L', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('EUR'),
      spot: { bid: 1.16, ask: 1.161, mid: 1.1605 },
    };
    const atm = sampleOptionMarketCharts({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: 'ATMF',
      amountLocalM: 10,
      optionPut: false,
      bundle,
    });
    const otm = sampleOptionMarketCharts({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: '1.28',
      amountLocalM: 10,
      optionPut: false,
      bundle,
    });
    expect(atm.payout).not.toBeNull();
    expect(otm.payout).not.toBeNull();
    expect(atm.payout!.points[0]!.spot).toBeCloseTo(otm.payout!.points[0]!.spot, 8);
    expect(atm.payout!.points.at(-1)!.spot).toBeCloseTo(
      otm.payout!.points.at(-1)!.spot,
      8,
    );
    expect(otm.payout!.strike).toBeGreaterThan(atm.payout!.strike);
    const atmAtRight = atm.payout!.points.at(-1)!;
    const otmAtRight = otm.payout!.points.at(-1)!;
    expect(otmAtRight.pnlUsdM).toBeLessThan(atmAtRight.pnlUsdM);
    expect(atm.payout!.pnlPerSpotUsdM).toBeCloseTo(otm.payout!.pnlPerSpotUsdM, 8);
    const itmSlope = (curve: NonNullable<typeof atm.payout>) => {
      let best = 0;
      for (let i = 1; i < curve.points.length; i++) {
        const ds = curve.points[i]!.spot - curve.points[i - 1]!.spot;
        const dp = curve.points[i]!.pnlUsdM - curve.points[i - 1]!.pnlUsdM;
        if (Math.abs(ds) > 1e-12) {
          const s = dp / ds;
          if (Math.abs(s) > Math.abs(best)) best = s;
        }
      }
      return best;
    };
    expect(itmSlope(atm.payout!)).toBeCloseTo(atm.payout!.pnlPerSpotUsdM, 6);
    expect(itmSlope(otm.payout!)).toBeCloseTo(otm.payout!.pnlPerSpotUsdM, 6);
  });

  it('scales option Δ to book notional: ITM → ±N, OTM → 0', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('EUR'),
      spot: { bid: 1.16, ask: 1.161, mid: 1.1605 },
    };
    const notional = 2.55;
    const call = sampleOptionMarketCharts({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: 'ATMF',
      amountLocalM: notional,
      optionPut: false,
      bundle,
    });
    const put = sampleOptionMarketCharts({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: 'ATMF',
      amountLocalM: notional,
      optionPut: true,
      bundle,
    });
    expect(call.payout).not.toBeNull();
    expect(put.payout).not.toBeNull();
    expect(call.payout!.notionalLocalM).toBeCloseTo(notional, 8);
    const callOtm = call.payout!.points[0]!;
    const callItm = call.payout!.points.at(-1)!;
    expect(callOtm.spot).toBeLessThan(call.payout!.strike);
    expect(callItm.spot).toBeGreaterThan(call.payout!.strike);
    expect(Math.abs(callOtm.deltaLocalM)).toBeLessThan(0.08 * notional);
    expect(callItm.deltaLocalM).toBeGreaterThan(0.92 * notional);
    expect(callItm.deltaLocalM).toBeLessThanOrEqual(notional + 1e-6);
    const putItm = put.payout!.points[0]!;
    const putOtm = put.payout!.points.at(-1)!;
    expect(putItm.deltaLocalM).toBeLessThan(-0.92 * notional);
    expect(putItm.deltaLocalM).toBeGreaterThanOrEqual(-notional - 1e-6);
    expect(Math.abs(putOtm.deltaLocalM)).toBeLessThan(0.08 * notional);
  });

  it('marks pre-expiry M2M off Black-Scholes, not a Δ-weighted blend', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('EUR'),
      spot: { bid: 1.16, ask: 1.161, mid: 1.1605 },
    };
    const call = sampleOptionMarketCharts({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: 'ATMF',
      amountLocalM: 10,
      optionPut: false,
      bundle,
    });
    expect(call.payout).not.toBeNull();
    const prem = Math.abs(call.payout!.premiumUsdM);
    const pts = call.payout!.points;
    const otm = pts[0]!;
    const itm = pts.at(-1)!;
    expect(otm.spot).toBeLessThan(call.payout!.strike);
    expect(itm.spot).toBeGreaterThan(call.payout!.strike);
    // Far below its strike the call is worthless, so the mark is the premium
    // LOST. The Δ-weighted blend returned the premium recovered (+prem) —
    // claiming a worthless option is always worth what was paid for it.
    expect(otm.markUsdM).toBeCloseTo(-prem, 2);
    expect(itm.markUsdM).toBeGreaterThan(0);
    // A long call's value rises monotonically with spot. The blend did not:
    // as |Δ| → 0 its (1 − w) · prem term pulled the curve back up.
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.markUsdM).toBeGreaterThan(pts[i - 1]!.markUsdM);
    }
    // A long option's value is never negative, so M2M never prints worse
    // than the premium paid. This is NOT the same as "M2M >= expiry P&L" —
    // that is the American bound, and it is false for a European put. See
    // the deep-ITM carry test below.
    for (const p of pts) {
      expect(p.markUsdM).toBeGreaterThanOrEqual(-prem - 1e-9);
    }
  });

  it('reprices the blue mark for remaining life and meets the payoff at expiry', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('EUR'),
      spot: { bid: 1.16, ask: 1.161, mid: 1.1605 },
    };
    const curve = sampleOptionMarketCharts({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: 'ATMF',
      amountLocalM: 10,
      optionPut: false,
      bundle,
    }).payout!;
    const now = payoutAtRemainingLife(curve, 1);
    expect(now).toBe(curve);
    const expired = payoutAtRemainingLife(curve, 0);
    for (const p of expired.points) {
      expect(p.markUsdM).toBeCloseTo(p.pnlUsdM, 9);
    }
    const half = payoutAtRemainingLife(curve, 0.5);
    const atSpot = (pts: typeof curve.points) =>
      pts.reduce((best, p) =>
        Math.abs(p.spot - curve.spot) < Math.abs(best.spot - curve.spot) ? p : best,
      );
    const spotNow = atSpot(curve.points);
    const spotHalf = atSpot(half.points);
    const spotEnd = atSpot(expired.points);
    // Bought ATM: today's value minus premium is near zero. Expiry intrinsic
    // is zero, so the green payoff is −premium. Halfway, time value remains
    // and the blue mark sits between those two.
    expect(spotNow.markUsdM).toBeGreaterThan(spotHalf.markUsdM);
    expect(spotHalf.markUsdM).toBeGreaterThan(spotEnd.markUsdM);
    expect(spotEnd.pnlUsdM).toBeCloseTo(-Math.abs(curve.premiumUsdM), 2);
  });

  it('marks a deep-ITM European put below its spot intrinsic by the carry', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('EUR'),
      spot: { bid: 1.1464, ask: 1.1474, mid: 1.1469 },
    };
    const priceLeg = (optionPut: boolean) =>
      sampleOptionMarketCharts({
        ccy: 'EUR',
        instrument: 'option',
        tenorMonths: 12,
        strikeInput: 'ATMF',
        amountLocalM: 10,
        optionPut,
        bundle,
      }).payout!;
    // EUR/USD sits at a forward premium (USD rates above EUR), and a
    // European option only settles at maturity, against the forward — so a
    // long put cannot capture K − S, only K − F. Deep ITM its mark is
    // therefore BELOW the expiry line by K·(F − S)/F × notional. That is
    // interest-rate carry, not a missing time value: do NOT "fix" it by
    // clamping M2M up to intrinsic. A deep-ITM call sits above its own
    // intrinsic by the same amount, which is the tell that this is carry
    // and not a sign slip.
    const put = priceLeg(true);
    const putItm = put.points[0]!;
    expect(putItm.spot).toBeLessThan(put.strike);
    expect(putItm.markUsdM).toBeLessThan(putItm.pnlUsdM);

    const call = priceLeg(false);
    const callItm = call.points.at(-1)!;
    expect(callItm.spot).toBeGreaterThan(call.strike);
    expect(callItm.markUsdM).toBeGreaterThan(callItm.pnlUsdM);

    expect(putItm.markUsdM - putItm.pnlUsdM).toBeCloseTo(
      -(callItm.markUsdM - callItm.pnlUsdM),
      3,
    );
  });

  it('discounts the drawn payoff on the same basis as the mark', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('EUR'),
      spot: { bid: 1.1464, ask: 1.1474, mid: 1.1469 },
    };
    const curve = sampleOptionMarketCharts({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: '1.30',
      amountLocalM: 10,
      optionPut: true,
      bundle,
    }).payout!;
    expect(curve.domesticRate).toBeGreaterThan(0);
    expect(curve.foreignRate).toBeGreaterThan(0);
    for (const basis of ['forward', 'spot'] as const) {
      const lived = payoutAtRemainingLife(curve, 1, basis);
      for (const p of lived.points) {
        expect(p.markUsdM).toBeGreaterThanOrEqual(p.pnlUsdM - 1e-6);
      }
      const expired = payoutAtRemainingLife(curve, 0, basis);
      for (const p of expired.points) {
        expect(p.markUsdM).toBeCloseTo(p.pnlUsdM, 8);
      }
    }
    const fwd = payoutAtRemainingLife(curve, 1, 'forward');
    const spot = payoutAtRemainingLife(curve, 1, 'spot');
    expect(fwd.points[0]!.markUsdM).toBeCloseTo(curve.points[0]!.markUsdM, 6);
    expect(fwd.points[0]!.pnlUsdM).not.toBeCloseTo(spot.points[0]!.pnlUsdM, 2);
  });

  it('samples the strike exactly so K and the kink are not grid-snapped', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('EUR'),
      spot: { bid: 1.16, ask: 1.161, mid: 1.1605 },
    };
    for (const strikeInput of ['ATMF', '1.1911', '1.0777']) {
      const curve = sampleOptionMarketCharts({
        ccy: 'EUR',
        instrument: 'option',
        tenorMonths: 12,
        strikeInput,
        amountLocalM: 10,
        optionPut: true,
        bundle,
      }).payout;
      expect(curve).not.toBeNull();
      const atK = curve!.points.filter(
        p => Math.abs(p.spot - curve!.strike) < 1e-12,
      );
      expect(atK).toHaveLength(1);
      // Intrinsic is zero at the strike, so the kink sits exactly on −premium.
      expect(atK[0]!.pnlUsdM).toBeCloseTo(-Math.abs(curve!.premiumUsdM), 9);
    }
  });

  it('reads IPA Put/Call words and prices the bullet year off the 1Y column', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('EUR'),
      spot: { bid: 1.161, ask: 1.1614, mid: 1.1612 },
      parameters: {
        ipaVolSurface: {
          surfaceTag: 'FxVol-EURUSD',
          fxCrossCode: 'EURUSD',
          xLabels: ['1M', '1Y'],
          yLabels: ['25D Put', 'ATM', '25D Call'],
          values: [
            [0.09, 0.11],
            [0.07, 0.08],
            [0.085, 0.095],
          ],
          errorMessage: '',
          pulledAt: '2026-08-30T12:00:00Z',
          xAxis: 'Tenor',
          yAxis: 'Delta',
        },
      },
    };
    const m12 = simulateTicketPrice({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: '25d',
      amountLocalM: 20,
      bundle,
    });
    const m1 = simulateTicketPrice({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 1,
      strikeInput: '25d',
      amountLocalM: 20,
      bundle,
    });
    expect(m12.blend.volSource).toBe('surface');
    expect(m12.quote.impliedVolPercent).toBeCloseTo(11, 5);
    expect(m1.quote.impliedVolPercent).toBeCloseTo(9, 5);
    expect(m12.quote.premiumUsd!).toBeGreaterThan(m1.quote.premiumUsd!);
    const { skew } = sampleOptionMarketCharts({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: '25d',
      amountLocalM: 20,
      bundle,
    });
    expect(skew.smile).toBe(true);
    const put25 = skew.points.find(p => /put|25p/i.test(p.label));
    expect(put25?.volPercent).toBeCloseTo(11, 5);
  });

  it('looks up vol when IPA stores Delta on X and Tenor on Y', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('JPY'),
      spot: { bid: 147.8, ask: 147.84, mid: 147.82 },
      parameters: {
        ipaVolSurface: {
          surfaceTag: 'FxVol-USDJPY',
          fxCrossCode: 'USDJPY',
          xLabels: ['25P', 'ATM', '25C'],
          yLabels: ['1M', '1Y'],
          values: [
            [0.09, 0.07, 0.085],
            [0.11, 0.08, 0.095],
          ],
          errorMessage: '',
          pulledAt: '2026-08-30T12:00:00Z',
          xAxis: 'Delta',
          yAxis: 'Tenor',
        },
      },
    };
    const priced = simulateTicketPrice({
      ccy: 'JPY',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: '25d',
      amountLocalM: 500,
      bundle,
    });
    expect(priced.blend.volSource).toBe('surface');
    expect(priced.quote.impliedVolPercent).toBeCloseTo(11, 5);
  });

  it('ignores a strike-axis wing that misses ATM and builds the delta smile instead', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('EUR'),
      spot: { bid: 1.161, ask: 1.1614, mid: 1.1612 },
      parameters: {
        ipaVolSurface: {
          surfaceTag: 'FxVol-EURUSD',
          fxCrossCode: 'EURUSD',
          xLabels: ['1Y'],
          yLabels: ['1.275', '1.290', '1.305', '1.330'],
          values: [[0.062], [0.077], [0.053], [0.075]],
          errorMessage: '',
          pulledAt: '2026-08-30T12:00:00Z',
          xAxis: 'Tenor',
          yAxis: 'Strike',
        },
      },
    };
    const { skew } = sampleOptionMarketCharts({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: 'ATMF',
      amountLocalM: 12,
      bundle,
    });
    const atm = skew.points.find(p => /atm/i.test(p.label));
    expect(atm).toBeTruthy();
    expect(atm!.strike).toBeCloseTo(skew.forward, 3);
    expect(Math.min(...skew.points.map(p => p.strike))).toBeLessThan(skew.forward);
    expect(Math.max(...skew.points.map(p => p.strike))).toBeGreaterThan(skew.forward);
  });

  it('plots tenor × decimal-delta vols when IPA tags the axes backwards', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('EUR'),
      spot: { bid: 1.161, ask: 1.1614, mid: 1.1612 },
      parameters: {
        ipaVolSurface: {
          surfaceTag: 'FxVol-EURUSD',
          fxCrossCode: 'EURUSD',
          xLabels: ['-0.10', '-0.25', 'ATM', '0.25', '0.10'],
          yLabels: ['ON', '1M', '1Y', '10Y'],
          values: [
            [6.71, 6.29, 5.97, 5.93, 6.05],
            [6.17, 5.66, 5.38, 5.41, 5.71],
            [7.66, 6.74, 6.35, 6.54, 7.32],
            [8.96, 8.09, 7.70, 7.90, 8.62],
          ],
          errorMessage: '',
          pulledAt: '2026-09-01',
          xAxis: 'Tenor',
          yAxis: 'Delta',
        },
      },
    };
    const priced = simulateTicketPrice({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: 'ATMF',
      amountLocalM: 12.1,
      bundle,
    });
    expect(priced.blend.volSource).toBe('surface');
    expect(priced.quote.impliedVolPercent).toBeCloseTo(6.35, 5);
    expect(priced.quote.premiumUsd).toBeGreaterThan(0);

    const { skew, premiumSurface } = sampleOptionMarketCharts({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 12,
      strikeInput: 'ATMF',
      amountLocalM: 12.1,
      bundle,
    });
    const atm = skew.points.find(p => /atm/i.test(p.label));
    expect(atm?.volPercent).toBeCloseTo(6.35, 5);
    expect(skew.points.some(p => /^(1M|1Y|10Y|ON)$/.test(p.label))).toBe(false);

    expect(premiumSurface).not.toBeNull();
    expect(premiumSurface!.tenors.map(t => t.label)).toEqual(['ON', '1M', '1Y', '10Y']);
    expect(premiumSurface!.rows.map(r => r.label)).toEqual([
      '10P',
      '25P',
      'ATM',
      '25C',
      '10C',
    ]);
    const yiAtm = premiumSurface!.rows.findIndex(r => r.label === 'ATM');
    const yi25p = premiumSurface!.rows.findIndex(r => r.label === '25P');
    const ti1y = premiumSurface!.tenors.findIndex(t => t.label === '1Y');
    const atmCell = premiumSurface!.cells[yiAtm]![ti1y]!;
    const put25Cell = premiumSurface!.cells[yi25p]![ti1y]!;
    expect(atmCell.volPercent).toBeCloseTo(6.35, 5);
    expect(put25Cell.volPercent).toBeCloseTo(6.74, 5);
    expect(atmCell.premiumUsd).toBeGreaterThan(0);
    expect(put25Cell.premiumUsd).toBeGreaterThan(0);
    const kAt = (label: string) => {
      const yi = premiumSurface!.rows.findIndex(r => r.label === label);
      return premiumSurface!.cells[yi]![ti1y]!.strike;
    };
    expect(kAt('10P')).toBeLessThan(kAt('25P'));
    expect(kAt('25P')).toBeLessThan(kAt('ATM'));
    expect(kAt('ATM')).toBeLessThan(kAt('25C'));
    expect(kAt('25C')).toBeLessThan(kAt('10C'));
  });

  it('reprices premium as live spot walks for delta-relative and fixed strike', () => {
    const bundle = {
      ...emptyMarketRatesForCcy('EUR'),
      spot: { bid: 1.16, ask: 1.1604, mid: 1.1602 },
    };
    const spot0 = bundle.spot;
    const spot1 = {
      bid: 1.1700,
      ask: 1.1704,
      mid: 1.1702,
    };
    const base = {
      ccy: 'EUR' as const,
      instrument: 'option' as const,
      tenorMonths: 6,
      amountLocalM: 12.1,
      bundle,
      optionPut: true,
    };
    const delta0 = simulateTicketPrice({
      ...base,
      strikeInput: '15DP',
      liveSpot: spot0,
    });
    const delta1 = simulateTicketPrice({
      ...base,
      strikeInput: '15DP',
      liveSpot: spot1,
    });
    expect(delta0.quote.premiumUsd).toBeGreaterThan(0);
    expect(delta1.quote.premiumUsd).not.toEqual(delta0.quote.premiumUsd);
    expect(delta1.quote.strike).not.toBeCloseTo(delta0.quote.strike!, 5);

    const k = delta0.quote.strike!;
    const abs0 = simulateTicketPrice({
      ...base,
      strikeInput: String(k),
      liveSpot: spot0,
    });
    const abs1 = simulateTicketPrice({
      ...base,
      strikeInput: String(k),
      liveSpot: spot1,
    });
    expect(abs0.quote.strike).toBeCloseTo(k, 6);
    expect(abs1.quote.strike).toBeCloseTo(k, 6);
    expect(abs1.quote.premiumUsd).not.toEqual(abs0.quote.premiumUsd);
  });

  it('exposes premium, vol, delta, gamma, vega and theta on an option quote', () => {
    const priced = simulateTicketPrice({
      ccy: 'EUR',
      instrument: 'option',
      tenorMonths: 6,
      strikeInput: 'ATMF',
      amountLocalM: 10,
      bundle: DEFAULT_EURUSD_MARKET_RATES,
      optionPut: true,
    });
    expect(priced.quote.premiumUsd).toBeGreaterThan(0);
    expect(priced.quote.premiumPercent).toBeGreaterThan(0);
    expect(priced.quote.impliedVolPercent).toBeGreaterThan(0);
    expect(priced.quote.deltaPercent).toBeLessThan(0);
    expect(priced.quote.gammaPercent).toBeGreaterThan(0);
    expect(priced.quote.vegaPercent).toBeGreaterThan(0);
    expect(priced.quote.thetaPercent).toBeLessThan(0);
    expect(priced.quote.vannaPercent).not.toBeNull();
    expect(priced.quote.volgaPercent).not.toBeNull();
  });
});
