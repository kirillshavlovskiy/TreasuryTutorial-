import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_EURUSD_MARKET_RATES,
  effectiveOvernightCash,
  emptyMarketRatesForCcy,
  interpolateDepositSide,
  cipTenorProfile,
  interpolateSwapPoints,
  isUsdBaseFcyPair,
  isUsdPerFcyQuoted,
  overnightCashFromDeposits,
  parseFxoCalculatorWorkbook,
  pickSharedUsdOvernight,
  impliedCarryRatePct,
  fwdCarryFromSwapPointsUsdM,
  fwdCarryMonthlyAccrualUsdM,
  fundingSwapFarLegCipUsdM,
  fundingSwapPathFarCipUsdM,
  resolveCashRatesForHorizon,
  resolveForwardDepositRates,
  resolveMarketRatesForCcy,
  resolveOvernightCashRates,
  bundleHasCipSwapPoints,
  selectCreditDebitRate,
  stampSharedUsdOvernight,
  swapPointsToUsdPerFcyDelta,
  swapPointsQuotedUsdPerDollar,
  usdMarketPair,
} from '@/lib/fx-market-rates';
import { CURRENCY_PARAMS } from '@/lib/fx-buffer';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import { stripHedgeLegCarryUsdM } from '@/lib/fx-hedge';

describe('fx-market-rates', () => {
  it('quotes EUR GBP AUD NZD as USD per FCY; everything else is FCY per USD', () => {
    expect(usdMarketPair('EUR')).toBe('EURUSD');
    expect(usdMarketPair('PLN')).toBe('USDPLN');
    expect(usdMarketPair('JPY')).toBe('USDJPY');
    for (const ccy of ['EUR', 'GBP', 'AUD', 'NZD']) {
      expect(isUsdPerFcyQuoted(ccy)).toBe(true);
      expect(usdMarketPair(ccy)).toBe(`${ccy}USD`);
      expect(isUsdBaseFcyPair({
        pair: `${ccy}USD`,
        baseCcy: ccy,
        quoteCcy: 'USD',
        spot: { bid: 1, ask: 1, mid: 1 },
      })).toBe(false);
    }
    for (const ccy of ['PLN', 'CHF', 'CAD', 'JPY', 'CZK', 'MXN']) {
      expect(isUsdPerFcyQuoted(ccy)).toBe(false);
      expect(isUsdBaseFcyPair({
        pair: `${ccy}USD`,
        baseCcy: ccy,
        quoteCcy: 'USD',
        spot: { bid: 1, ask: 1, mid: 1 },
      })).toBe(true);
    }
  });

  it('seeds EURUSD with separate overnight cash vs term deposits', () => {
    const oneM = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '1M');
    expect(oneM).toBeTruthy();
    expect(oneM!.usd.creditPct).toBeCloseTo(3.687, 3);
    expect(oneM!.usd.debitPct).toBeCloseTo(3.993, 3);
    expect(oneM!.eur.creditPct).toBeCloseTo(2.26, 3);
    expect(oneM!.eur.debitPct).toBeCloseTo(2.56, 3);
    const on = effectiveOvernightCash(DEFAULT_EURUSD_MARKET_RATES, 'EUR');
    // Applied overnightCash on the seed bundle (SW→O/N desk rates).
    expect(on.base.creditPct).toBeCloseTo(2.15, 2);
    expect(on.base.debitPct).toBeCloseTo(2.35, 2);
    expect(on.base.creditPct).not.toBeCloseTo(oneM!.eur.creditPct, 1);
  });

  it('picks credit for long and debit for short', () => {
    expect(selectCreditDebitRate(1, 2, 4).side).toBe('credit');
    expect(selectCreditDebitRate(-1, 2, 4).ratePct).toBe(4);
  });

  it('interpolates deposit curve', () => {
    const mid = interpolateDepositSide(
      DEFAULT_EURUSD_MARKET_RATES.deposits,
      'usd',
      1,
    );
    expect(mid.creditPct).toBeCloseTo(3.687, 3);
  });

  it('parses the bundled FXOCalculator workbook', () => {
    const buf = readFileSync(
      join(process.cwd(), 'data/fx-market-rates/FXOCalculator EURUSD.xlsx'),
    );
    const ab = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
    const parsed = parseFxoCalculatorWorkbook(
      ab,
      'FXOCalculator EURUSD.xlsx',
    );
    expect(parsed.deposits.length).toBeGreaterThan(5);
    const oneM = parsed.deposits.find(d => d.tenor === '1M');
    expect(oneM?.usd.debitPct).toBeGreaterThan(oneM!.usd.creditPct);
  });

  it('forward carry uses EURUSD swap points column', () => {
    const oneM = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '1M');
    expect(oneM?.swapPoints?.bid).toBeCloseTo(14.14, 2);
    const pts = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: 10,
      settleMonths: 1,
      bundle: DEFAULT_EURUSD_MARKET_RATES,
    });
    expect(pts).toBeTruthy();
    expect(pts!.side).toBe('ask');
    expect(pts!.points).toBeCloseTo(14.19, 2);
    expect(pts!.fwdCarryUsdM).toBeCloseTo(10 * (14.19 / 10_000), 6);
  });

  it('EURUSD 1M premium implies EUR pays vs USD (not earns)', () => {
    const rUsd = 3.5;
    const r = impliedCarryRatePct(DEFAULT_EURUSD_MARKET_RATES, 1, 0, rUsd);
    expect(r).not.toBeNull();
    // +14 pts / 1.15 spot ≈ 1.5% — CIP must subtract, landing near the 1M EUR deposit (~2.3).
    expect(r!).toBeLessThan(rUsd - 0.8);
    expect(r!).toBeGreaterThan(1.4);
    expect(r!).toBeLessThan(2.8);
  });

  it('USDPLN negative points earn CIP on a long (sell PLN far at the ask)', () => {
    const S = 1 / CURRENCY_PARAMS.PLN!.spot;
    const bid = -92;
    const ask = -80;
    const bundle: FxMarketRatesBundle = {
      pair: 'USDPLN',
      baseCcy: 'USD',
      quoteCcy: 'PLN',
      sourceFile: 'test',
      spot: { bid: S, ask: S, mid: S },
      deposits: [{
        tenor: '1Y',
        months: 12,
        eur: { creditPct: 3.41, debitPct: 4.41 },
        usd: { creditPct: 3.50, debitPct: 3.89 },
        swapPoints: { bid, ask },
      }],
    };
    expect(isUsdBaseFcyPair(bundle)).toBe(true);

    const FAsk = S + ask / 10_000;
    const earnPerPln = 1 / FAsk - 1 / S;
    expect(earnPerPln).toBeGreaterThan(0);
    expect(swapPointsToUsdPerFcyDelta(ask, bundle)).toBeCloseTo(earnPerPln, 10);

    const long = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: 10,
      settleMonths: 12,
      bundle,
    });
    expect(long).toBeTruthy();
    expect(long!.side).toBe('ask');
    expect(long!.points).toBe(ask);
    expect(long!.fwdCarryUsdM).toBeGreaterThan(0);
    expect(long!.fwdCarryUsdM).toBeCloseTo(10 * earnPerPln, 8);
    // Mid would overstate the earn (more negative points).
    const mid = (bid + ask) / 2;
    const FMid = S + mid / 10_000;
    expect(long!.fwdCarryUsdM).toBeLessThan(10 * (1 / FMid - 1 / S));
    // Naive N × points/10_000 would print a cost.
    expect(long!.fwdCarryUsdM).not.toBeCloseTo(10 * (ask / 10_000), 4);

    const short = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: -10,
      settleMonths: 12,
      bundle,
    });
    expect(short!.side).toBe('bid');
    expect(short!.points).toBe(bid);

    const cip = fundingSwapFarLegCipUsdM({
      standingLocalM: 10,
      settleMonths: 12,
      bundle,
    });
    expect(cip).toBeCloseTo(10 * earnPerPln, 8);
  });

  it('PLNUSD-labeled negative 1Y points still earn on a +21.6M long (not N × pts/10_000)', () => {
    const pts = -62;
    const standing = 21.6;
    const naive = standing * (pts / 10_000);
    const bundle: FxMarketRatesBundle = {
      pair: 'PLNUSD',
      baseCcy: 'PLN',
      quoteCcy: 'USD',
      sourceFile: 'test',
      spot: {
        bid: CURRENCY_PARAMS.PLN!.spot,
        ask: CURRENCY_PARAMS.PLN!.spot,
        mid: CURRENCY_PARAMS.PLN!.spot,
      },
      deposits: [{
        tenor: '1Y',
        months: 12,
        eur: { creditPct: 3.41, debitPct: 4.41 },
        usd: { creditPct: 3.50, debitPct: 3.89 },
        swapPoints: { bid: pts, ask: pts },
      }],
    };
    expect(isUsdBaseFcyPair(bundle)).toBe(true);
    expect(swapPointsQuotedUsdPerDollar(bundle, pts)).toBe(true);

    const S = 1 / CURRENCY_PARAMS.PLN!.spot;
    const F = S + pts / 10_000;
    const earn = standing * (1 / F - 1 / S);
    expect(earn).toBeGreaterThan(0);
    expect(naive).toBeLessThan(-0.1);

    const cip = fundingSwapFarLegCipUsdM({
      standingLocalM: standing,
      settleMonths: 12,
      bundle,
    });
    expect(cip).toBeGreaterThan(0);
    expect(cip).toBeCloseTo(earn, 6);
    expect(cip).not.toBeCloseTo(naive, 3);
    expect(Math.abs(cip)).toBeLessThan(0.03);
  });

  it('desk-assigned PLNPLN (USDPLN file) still earns CIP on a +21.6M 1Y long — not −$134k', () => {
    const pts = -62;
    const standing = 21.6;
    const naive = standing * (pts / 10_000);
    const S = 1 / CURRENCY_PARAMS.PLN!.spot;
    const bundle: FxMarketRatesBundle = {
      pair: 'PLNPLN',
      baseCcy: 'PLN',
      quoteCcy: 'PLN',
      sourceFile: 'FXOCalculator USDPLN.xlsx',
      spot: { bid: S, ask: S, mid: S },
      deposits: [{
        tenor: '1Y',
        months: 12,
        eur: { creditPct: 3.41, debitPct: 4.41 },
        usd: { creditPct: 3.50, debitPct: 3.89 },
        swapPoints: { bid: pts, ask: pts },
      }],
    };
    expect(isUsdBaseFcyPair(bundle)).toBe(true);
    expect(naive).toBeCloseTo(-0.134, 3);

    const F = S + pts / 10_000;
    const earn = standing * (1 / F - 1 / S);
    const cip = fundingSwapFarLegCipUsdM({
      standingLocalM: standing,
      settleMonths: 12,
      bundle,
    });
    expect(cip).toBeGreaterThan(0);
    expect(cip).toBeCloseTo(earn, 6);
    expect(cip).not.toBeCloseTo(naive, 3);
    expect(Math.abs(cip)).toBeLessThan(0.03);
  });

  it('EUR-labelled USDPLN file (PLN spot, −62 pts) still inverts, not N × pts/10_000', () => {
    const pts = -62;
    const standing = 21.6;
    const naive = standing * (pts / 10_000);
    const S = 1 / CURRENCY_PARAMS.PLN!.spot;
    const mislabeled: FxMarketRatesBundle = {
      pair: 'EURUSD',
      baseCcy: 'EUR',
      quoteCcy: 'USD',
      sourceFile: 'stale',
      spot: { bid: S, ask: S, mid: S },
      deposits: [{
        tenor: '1Y',
        months: 12,
        eur: { creditPct: 3.41, debitPct: 4.41 },
        usd: { creditPct: 3.50, debitPct: 3.89 },
        swapPoints: { bid: pts, ask: pts },
      }],
    };
    const bundle = resolveMarketRatesForCcy({ PLN: mislabeled }, 'PLN');
    expect(bundle.pair).toBe('USDPLN');
    expect(bundle.baseCcy).toBe('PLN');
    expect(isUsdBaseFcyPair(bundle)).toBe(true);
    const F = S + pts / 10_000;
    const earn = standing * (1 / F - 1 / S);
    const cip = fundingSwapFarLegCipUsdM({
      standingLocalM: standing,
      settleMonths: 12,
      bundle,
    });
    expect(cip).toBeGreaterThan(0);
    expect(cip).toBeCloseTo(earn, 6);
    expect(cip).not.toBeCloseTo(naive, 3);
  });

  it('empty EUR book shell does not shadow the bundled EURUSD CIP curve', () => {
    const shell = emptyMarketRatesForCcy('EUR');
    expect(bundleHasCipSwapPoints(shell)).toBe(false);
    const bundle = resolveMarketRatesForCcy({ EUR: shell }, 'EUR');
    expect(bundleHasCipSwapPoints(bundle)).toBe(true);
    const oneM = bundle.deposits.find(d => d.tenor === '1M');
    expect(oneM?.swapPoints?.bid).toBeCloseTo(14.14, 2);
    expect(bundle.overnightCash?.base.creditPct).toBeCloseTo(
      shell.overnightCash!.base.creditPct,
      6,
    );
    const cip = fundingSwapFarLegCipUsdM({
      standingLocalM: -40,
      settleMonths: 12,
      bundle,
    });
    expect(cip).toBeCloseTo(
      fundingSwapFarLegCipUsdM({
        standingLocalM: -40,
        settleMonths: 12,
        bundle: DEFAULT_EURUSD_MARKET_RATES,
      }),
      8,
    );
    expect(Math.abs(cip)).toBeGreaterThan(0.05);
  });

  it('EURUSD seed on a PLN book is not USDPLN — drop points, CIP falls back', () => {
    const standing = 1.8;
    const bundle = resolveMarketRatesForCcy(
      { PLN: DEFAULT_EURUSD_MARKET_RATES },
      'PLN',
    );
    expect(bundle.pair).toBe('USDPLN');
    expect(bundle.deposits.every(d => d.swapPoints == null)).toBe(true);
    const oneM = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '1M');
    const naiveEur = standing * ((((oneM?.swapPoints?.bid ?? 0) + (oneM?.swapPoints?.ask ?? 0)) / 2) / 10_000);
    const cip = fundingSwapFarLegCipUsdM({
      standingLocalM: standing,
      settleMonths: 1,
      bundle,
      fallbackUsdM: 0.01,
    });
    expect(cip).toBeCloseTo(0.01, 12);
    expect(cip).not.toBeCloseTo(naiveEur, 4);
    expect(cip).not.toBeCloseTo(-0.0011, 3);
  });

  it('prices 1M / 6M / 12M CIP from the 3W–12M mid profile, not SW/2W', () => {
    const S = 1 / CURRENCY_PARAMS.PLN!.spot;
    const standing = 21.6;
    const knot = (
      tenor: string,
      months: number,
      bid: number,
      ask: number,
    ) => ({
      tenor,
      months,
      eur: { creditPct: 3.41, debitPct: 4.41 },
      usd: { creditPct: 3.50, debitPct: 3.89 },
      swapPoints: { bid, ask },
    });
    const bundle: FxMarketRatesBundle = {
      pair: 'USDPLN',
      baseCcy: 'PLN',
      quoteCcy: 'PLN',
      sourceFile: 'test',
      spot: { bid: S, ask: S, mid: S },
      deposits: [
        knot('SW', 7 / 30, 18, 22),
        knot('2W', 14 / 30, 10, 14),
        knot('3W', 21 / 30, -4, -3),
        knot('1M', 1, -9, -8),
        knot('3M', 3, -22, -20),
        knot('6M', 6, -40, -36),
        knot('1Y', 12, -62, -55),
      ],
    };
    const sw = interpolateSwapPoints(bundle.deposits, 1);
    expect(sw).toBeTruthy();
    expect(sw!.mid).toBeCloseTo(-8.5, 6);
    expect(sw!.mid).toBeLessThan(0);

    for (const months of [1, 6, 12]) {
      const cip = fundingSwapFarLegCipUsdM({
        standingLocalM: standing,
        settleMonths: months,
        bundle,
      });
      expect(cip, `${months}M`).toBeGreaterThan(0);
    }
    const rolling = fundingSwapPathFarCipUsdM({
      plan: Array.from({ length: 12 }, () => ({ standing_swap: standing, far_leg: 0 })),
      standingFallback: standing,
      forecastMonths: 12,
      bundle,
      fallbackAnnualUsdYr: () => 0,
    });
    expect(rolling).toBeGreaterThan(0);

    const profile = cipTenorProfile({
      notionalLocalM: standing,
      bundle,
      bookedMonths: 12,
      maxMonths: 12,
    });
    expect(profile.every(k => k.cipUsdM > 0)).toBe(true);
    expect(profile.some(k => k.tenor === 'SW')).toBe(false);
    expect(profile.find(k => k.tenor === '1Y')?.booked).toBe(true);
    expect(profile.every(k => k.months <= 12.35)).toBe(true);
    expect(profile.some(k => k.months >= 15)).toBe(false);
  });

  it('rolling CIP is 1M on the path; a 3M forecast never reads 12M', () => {
    const S = 1 / CURRENCY_PARAMS.PLN!.spot;
    const standing = 21.6;
    const knot = (
      tenor: string,
      months: number,
      bid: number,
      ask: number,
    ) => ({
      tenor,
      months,
      eur: { creditPct: 3.41, debitPct: 4.41 },
      usd: { creditPct: 3.50, debitPct: 3.89 },
      swapPoints: { bid, ask },
    });
    const bundle: FxMarketRatesBundle = {
      pair: 'USDPLN',
      baseCcy: 'PLN',
      quoteCcy: 'PLN',
      sourceFile: 'test',
      spot: { bid: S, ask: S, mid: S },
      deposits: [
        knot('1M', 1, -9, -8),
        knot('3M', 3, -22, -20),
        knot('1Y', 12, 400, 420),
      ],
    };
    const oneM = interpolateSwapPoints(bundle.deposits, 1, bundle);
    expect(oneM!.mid).toBeCloseTo(-8.5, 6);
    const rolling = fundingSwapPathFarCipUsdM({
      plan: [
        { standing_swap: standing, far_leg: 0, cycleIndex: 0 },
        { standing_swap: standing, far_leg: 0, cycleIndex: 1 },
        { standing_swap: standing, far_leg: 0, cycleIndex: 2 },
      ],
      standingFallback: standing,
      forecastMonths: 3,
      bundle,
      fallbackAnnualUsdYr: () => 0,
    });
    // Cycle 0 is spot-starting (the curve's own 1M knot). Cycles 1 and 2 are
    // forward-starting — each cycle's OWN 1-month roll is priced off the
    // forward-forward window for that cycle (curve at cycleIndex → curve at
    // cycleIndex+1), not the spot-1M knot reused for every cycle regardless
    // of how far out it is. On a sloped curve these three legs are NOT equal.
    const oneMCip = fundingSwapFarLegCipUsdM({
      standingLocalM: standing,
      settleMonths: 1,
      startMonths: 0,
      bundle,
    });
    const secondLegCip = fundingSwapFarLegCipUsdM({
      standingLocalM: standing,
      settleMonths: 1,
      startMonths: 1,
      bundle,
    });
    const thirdLegCip = fundingSwapFarLegCipUsdM({
      standingLocalM: standing,
      settleMonths: 1,
      startMonths: 2,
      bundle,
    });
    expect(rolling).toBeCloseTo(oneMCip + secondLegCip + thirdLegCip, 8);
    // The curve steepens (points go from -8.5 at 1M toward -21 at 3M), so each
    // successive forward-starting 1-month leg prices differently from the
    // spot-starting one — confirming this is no longer a flat repeat.
    expect(secondLegCip).not.toBeCloseTo(oneMCip, 6);
    expect(rolling).not.toBeCloseTo(3 * oneMCip, 6);
    expect(rolling).toBeGreaterThan(0);
    const profile = cipTenorProfile({
      notionalLocalM: standing,
      bundle,
      bookedMonths: 1,
      maxMonths: 3,
    });
    expect(profile.some(k => k.tenor === '1Y')).toBe(false);
    expect(profile.some(k => k.tenor === '3M')).toBe(false);
    expect(profile.some(k => k.tenor === '1M')).toBe(true);
  });

  it('monthly CIP is the booked far / months, not CIP(4M)−CIP(3M)', () => {
    const S = 1 / CURRENCY_PARAMS.PLN!.spot;
    const standing = 21.6;
    const knot = (
      tenor: string,
      months: number,
      bid: number,
      ask: number,
    ) => ({
      tenor,
      months,
      eur: { creditPct: 3.41, debitPct: 4.41 },
      usd: { creditPct: 3.50, debitPct: 3.89 },
      swapPoints: { bid, ask },
    });
    const bundle: FxMarketRatesBundle = {
      pair: 'USDPLN',
      baseCcy: 'PLN',
      quoteCcy: 'PLN',
      sourceFile: 'test',
      spot: { bid: S, ask: S, mid: S },
      deposits: [
        knot('1M', 1, -9, -8),
        knot('3M', 3, -22, -20),
        knot('4M', 4, 30, 32),
        knot('12M', 12, -62, -55),
      ],
    };
    const far = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: standing,
      settleMonths: 12,
      bundle,
    })!.fwdCarryUsdM;
    expect(far).toBeGreaterThan(0);
    const walkM4 =
      fwdCarryFromSwapPointsUsdM({
        notionalLocalM: standing,
        settleMonths: 4,
        bundle,
      })!.fwdCarryUsdM
      - fwdCarryFromSwapPointsUsdM({
        notionalLocalM: standing,
        settleMonths: 3,
        bundle,
      })!.fwdCarryUsdM;
    expect(walkM4).toBeLessThan(0);
    const months = Array.from({ length: 12 }, (_, i) =>
      fwdCarryMonthlyAccrualUsdM({
        notionalLocalM: standing,
        settleMonths: 12,
        month: i + 1,
        bundle,
      }),
    );
    expect(months.every(v => v > 0)).toBe(true);
    expect(months.reduce((s, v) => s + v, 0)).toBeCloseTo(far, 8);
    expect(months[3]).toBeCloseTo(far / 12, 8);
  });

  it('drops CIP knots past the forecast horizon', () => {
    const capped = cipTenorProfile({
      notionalLocalM: -5.4,
      bundle: DEFAULT_EURUSD_MARKET_RATES,
      bookedMonths: 12,
      maxMonths: 12,
    });
    expect(capped.some(k => k.tenor === '1Y')).toBe(true);
    expect(capped.some(k => k.tenor === '15M')).toBe(false);
    expect(capped.some(k => k.tenor === '10Y')).toBe(false);
    expect(capped.every(k => k.months <= 12.35)).toBe(true);
  });

  it('prices funding-swap far-leg CIP from swap points, not overnight cash Δr', () => {
    const short = -40;
    // Short standing buys FCY far → bid.
    const oneYBid = 170.1;
    const term = fundingSwapFarLegCipUsdM({
      standingLocalM: short,
      settleMonths: 12,
      bundle: DEFAULT_EURUSD_MARKET_RATES,
    });
    expect(term).toBeCloseTo(short * (oneYBid / 10_000), 6);
    const overnight = short * ((1.78 - 3.50) / 100) * 1.1701;
    expect(Math.abs(term)).not.toBeCloseTo(Math.abs(overnight), 2);

    const rolling = fundingSwapPathFarCipUsdM({
      plan: [
        { standing_swap: short, far_leg: 0, cycleIndex: 0 },
        { standing_swap: short, far_leg: 0, cycleIndex: 1 },
      ],
      standingFallback: short,
      forecastMonths: 12,
      bundle: DEFAULT_EURUSD_MARKET_RATES,
      fallbackAnnualUsdYr: () => 0,
    });
    const oneMBid = 14.14;
    const firstLeg = short * (oneMBid / 10_000);
    // Cycle 0 is spot-starting (curve's own 1M knot). Cycle 1 starts a month
    // forward — its own 1-month roll is priced off the forward-forward window
    // (curve at 1M → curve at 2M), not the spot-1M knot reused unchanged.
    const secondLeg = fundingSwapFarLegCipUsdM({
      standingLocalM: short,
      settleMonths: 1,
      startMonths: 1,
      bundle: DEFAULT_EURUSD_MARKET_RATES,
    });
    expect(rolling).toBeCloseTo(firstLeg + secondLeg, 6);
    expect(rolling).not.toBeCloseTo(2 * firstLeg, 4);

    const termPath = fundingSwapPathFarCipUsdM({
      plan: [
        { standing_swap: short, cycleIndex: 0, far_leg: 0 },
        { standing_swap: short, cycleIndex: 11, far_leg: -short },
      ],
      standingFallback: short,
      forecastMonths: 12,
      bundle: DEFAULT_EURUSD_MARKET_RATES,
      fallbackAnnualUsdYr: () => 0,
    });
    expect(termPath).toBeCloseTo(term, 6);
  });

  it('carry uses overnight for cash int and swap points for FWD', () => {
    const fwd = resolveForwardDepositRates(
      DEFAULT_EURUSD_MARKET_RATES,
      'EUR',
      6,
    );
    const cash = resolveOvernightCashRates(DEFAULT_EURUSD_MARKET_RATES, 'EUR');
    const pts = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: 10,
      settleMonths: 6,
      bundle: DEFAULT_EURUSD_MARKET_RATES,
    });
    expect(cash.fcy.creditPct).not.toBeCloseTo(fwd.fcy.creditPct, 1);
    const long = stripHedgeLegCarryUsdM({
      notionalLocalM: 10,
      ccy: 'EUR',
      recognizeMonths: 0,
      settleMonths: 6,
      forecastEndMonths: 12,
      fcyFwdRates: fwd.fcy,
      usdFwdRates: fwd.usd,
      fcyCashRates: cash.fcy,
      usdCashRates: cash.usd,
      swapPointsCarryUsdM: pts?.fwdCarryUsdM,
      swapPoints: pts?.points,
      swapPointsSide: pts?.side,
    });
    expect(long.r_FCY_used).toBeCloseTo(cash.fcy.creditPct, 3);
    expect(long.swapPoints).toBeTruthy();
    expect(long.fwdCarryUsdM).toBeCloseTo(pts!.fwdCarryUsdM, 8);
  });

  it('uses per-CCY uploaded curve for overnight and term (not EUR-only)', () => {
    const plnBundle = {
      ...DEFAULT_EURUSD_MARKET_RATES,
      pair: 'PLNUSD',
      baseCcy: 'PLN',
      overnightCash: {
        base: { creditPct: 3.41, debitPct: 4.41 },
        usd: { creditPct: 3.5, debitPct: 3.89 },
      },
    };
    const cash = resolveOvernightCashRates(plnBundle, 'PLN');
    const fwd = resolveForwardDepositRates(plnBundle, 'PLN', 1);
    // Applied overnightCash wins (not SW deposit column).
    expect(cash.fcy.creditPct).toBeCloseTo(3.41, 2);
    expect(fwd.fcy.creditPct).toBeCloseTo(2.26, 2);
    const gbpCash = resolveOvernightCashRates(plnBundle, 'GBP');
    expect(gbpCash.source).toContain('LP');
  });

  it('suggests EUR SW→O/N 2.15/2.35 without overwriting SW deposits', () => {
    const sw = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === 'SW');
    expect(sw).toBeTruthy();
    const depositsNoOn = DEFAULT_EURUSD_MARKET_RATES.deposits.filter(
      d => !['ON', 'TN', 'SN'].includes(d.tenor),
    );
    const suggested = overnightCashFromDeposits(depositsNoOn, 'EUR');
    expect(suggested.base.creditPct).toBeCloseTo(2.15, 3);
    expect(suggested.base.debitPct).toBeCloseTo(2.35, 3);
    expect(suggested.usd.creditPct).toBeCloseTo(sw!.usd.creditPct, 3);
    // SW term row unchanged.
    expect(sw!.eur.creditPct).toBeCloseTo(2.09, 2);
  });

  it('takes USD overnight/term from peer FCY pair files (no USD upload)', () => {
    const map = {
      EUR: {
        ...DEFAULT_EURUSD_MARKET_RATES,
        overnightCash: {
          base: { creditPct: 2.15, debitPct: 2.35 },
          usd: { creditPct: 3.505, debitPct: 3.809 },
        },
      },
    };
    const bundle = resolveMarketRatesForCcy(map, 'USD');
    expect(bundle.baseCcy).toBe('EUR');
    const cash = resolveOvernightCashRates(bundle, 'USD');
    expect(cash.fcy.creditPct).toBeCloseTo(3.505, 3);
    expect(cash.source).toContain('USD overnight (shared)');
    const fwd = resolveForwardDepositRates(bundle, 'USD', 1);
    const oneM = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '1M');
    expect(fwd.fcy.creditPct).toBeCloseTo(oneM!.usd.creditPct, 3);
  });

  it('uses O/N near 0 and SW–1Y term for longer cash horizons', () => {
    const on = resolveCashRatesForHorizon(DEFAULT_EURUSD_MARKET_RATES, 'EUR', 0);
    expect(on.fcy.creditPct).toBeCloseTo(2.15, 2);
    const at6m = resolveCashRatesForHorizon(
      DEFAULT_EURUSD_MARKET_RATES,
      'EUR',
      6,
    );
    const sixM = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '6M')!;
    expect(at6m.fcy.creditPct).toBeCloseTo(sixM.eur.creditPct, 3);
    expect(at6m.source).toMatch(/term|cash/);
  });

  it('current mode keeps flat O/N for every cash horizon', () => {
    const withOn = {
      ...DEFAULT_EURUSD_MARKET_RATES,
      overnightCash: {
        base: { creditPct: 1.78, debitPct: 2.21 },
        usd: { creditPct: 3.5, debitPct: 3.89 },
      },
      cashInterestMode: 'current' as const,
    };
    const at0 = resolveCashRatesForHorizon(withOn, 'EUR', 0);
    const at5 = resolveCashRatesForHorizon(withOn, 'EUR', 5);
    expect(at0.fcy.creditPct).toBeCloseTo(1.78, 3);
    expect(at5.fcy.creditPct).toBeCloseTo(1.78, 3);
    expect(at5.source).toMatch(/flat current/);
  });

  it('stamps shared USD O/N onto every currency bundle', () => {
    const map = stampSharedUsdOvernight(
      {
        EUR: {
          ...DEFAULT_EURUSD_MARKET_RATES,
          overnightCash: {
            base: { creditPct: 1.78, debitPct: 2.21 },
            usd: { creditPct: 3.5, debitPct: 3.89 },
          },
        },
        PLN: emptyMarketRatesForCcy('PLN'),
      },
      { creditPct: 4.1, debitPct: 4.4 },
    );
    expect(map.EUR!.overnightCash!.usd.creditPct).toBeCloseTo(4.1, 6);
    expect(map.PLN!.overnightCash!.usd.debitPct).toBeCloseTo(4.4, 6);
    expect(map.EUR!.overnightCash!.base.creditPct).toBeCloseTo(1.78, 6);
    expect(pickSharedUsdOvernight(map).creditPct).toBeCloseTo(4.1, 6);
  });
});
