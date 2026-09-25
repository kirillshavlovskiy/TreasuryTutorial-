import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EURUSD_MARKET_RATES,
  swapPointsToPriceDelta,
} from '@/lib/fx-market-rates';
import { simulateTicketPrice } from '@/lib/test-mode/sim-ticket-price';
import {
  bookedForwardFromSpotFill,
  clickTradePadQuote,
  clickTradePadResetsToSpot,
  leaveRateFieldEnabled,
  stripPadShowsLiveQuote,
  spotTileStripLegFields,
  stripLegTenorFields,
  stripLevelCanPlace,
  stripLevelFillRate,
  stripLevelNeedsSpotReset,
  stripSpotTenorFields,
  type StripLegTenor,
} from '@/lib/test-mode/click-trade-pad';

const LIVE_EURUSD = { bid: 1.1621, ask: 1.1623, mid: 1.1622 };

describe('clickTradePadQuote', () => {
  it('spot pad is the live /api/fx-spot print, not a priced 2M outright', () => {
    const pad = clickTradePadQuote({
      instrument: 'spot',
      livePrint: LIVE_EURUSD,
      pricedBid: 1.15553,
      pricedAsk: 1.15574,
    });
    expect(pad).toEqual(LIVE_EURUSD);
  });

  it('does not show the FXOCalculator 2M seed outright when fx-spot is missing', () => {
    const seed2m = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '2M');
    expect(seed2m?.outright?.ask).toBeCloseTo(1.15574, 5);
    const pad = clickTradePadQuote({
      instrument: 'forward',
      livePrint: null,
      pricedBid: seed2m!.outright!.bid,
      pricedAsk: seed2m!.outright!.ask,
    });
    expect(pad).toBeNull();
  });

  it('rebases 2M points onto live 1.1622 instead of the seed 1.1557 outright', () => {
    const bundle = DEFAULT_EURUSD_MARKET_RATES;
    const seed2m = bundle.deposits.find(d => d.tenor === '2M')!;
    const bid = simulateTicketPrice({
      ccy: 'EUR',
      instrument: 'forward',
      tenorMonths: 2,
      amountLocalM: 1,
      bundle,
      liveSpot: LIVE_EURUSD,
      quoteSide: 'bid',
    });
    const ask = simulateTicketPrice({
      ccy: 'EUR',
      instrument: 'forward',
      tenorMonths: 2,
      amountLocalM: 1,
      bundle,
      liveSpot: LIVE_EURUSD,
      quoteSide: 'ask',
    });
    const pad = clickTradePadQuote({
      instrument: 'forward',
      livePrint: LIVE_EURUSD,
      pricedBid: bid.quote.fxOutright,
      pricedAsk: ask.quote.fxOutright,
    });
    const pts = seed2m.swapPoints!;
    expect(pad).not.toBeNull();
    if (!pad) return;
    expect(pad.bid).toBeCloseTo(
      LIVE_EURUSD.mid + swapPointsToPriceDelta(pts.bid ?? 0, 'EUR'),
      6,
    );
    expect(pad.ask).toBeCloseTo(
      LIVE_EURUSD.mid + swapPointsToPriceDelta(pts.ask ?? 0, 'EUR'),
      6,
    );
    expect(Math.abs(pad.mid - (seed2m.outright?.ask ?? 0))).toBeGreaterThan(0.005);
    expect(pad.mid).toBeGreaterThan(1.16);
  });

  it('does not put live spot on one tile when only one FWD outright is ready', () => {
    const pad = clickTradePadQuote({
      instrument: 'forward',
      livePrint: LIVE_EURUSD,
      pricedBid: 1.1701,
      pricedAsk: null,
    });
    expect(pad).not.toBeNull();
    if (!pad) return;
    expect(pad.bid).toBeCloseTo(1.1701, 6);
    expect(pad.ask).toBeCloseTo(1.1701 + (LIVE_EURUSD.ask - LIVE_EURUSD.bid), 6);
    expect(pad.bid).not.toBeCloseTo(LIVE_EURUSD.bid, 4);
  });
});

describe('strip-level spot pad', () => {
  const stripFwd = {
    structure: 'strip' as const,
    instrument: 'forward' as const,
    legCount: 5,
  };

  it('books a whole-strip FWD pad at each leg\'s own outright', () => {
    expect(stripLevelNeedsSpotReset(stripFwd)).toBe(false);
    expect(stripLevelCanPlace(stripFwd)).toBe(true);
    expect(
      stripLevelFillRate({
        ...stripFwd,
        target: 'main',
        liveSpotPx: 1.1622,
        legOutrightPx: 1.1557,
      }),
    ).toBe(1.1557);
  });

  it('books each leg at its own outright on a whole-strip execution', () => {
    const spot = { structure: 'strip' as const, instrument: 'spot' as const, legCount: 5 };
    expect(stripLevelNeedsSpotReset(spot)).toBe(false);
    expect(stripLevelCanPlace(spot)).toBe(true);
    // The spot tile is what the pad shows and references — the booking is
    // still per leg: an M6 and an M12 forward must not both trade at the
    // spot print (2026-09-08 desk report).
    expect(
      stripLevelFillRate({
        ...spot,
        target: 'main',
        liveSpotPx: 1.1622,
        legOutrightPx: 1.1557,
      }),
    ).toBe(1.1557);
    // A leg without its own quote still executes — at the spot fallback.
    expect(
      stripLevelFillRate({
        ...spot,
        target: 'main',
        liveSpotPx: 1.1622,
        legOutrightPx: null,
      }),
    ).toBe(1.1622);
    expect(stripSpotTenorFields()).toEqual({
      instrument: 'spot',
      maturity: null,
      maturityMonths: 0,
      maturityLabel: null,
    });
  });

  it('keeps a single-leg forward fill on that row\'s outright', () => {
    expect(
      stripLevelFillRate({
        structure: 'strip',
        instrument: 'forward',
        target: 'leg',
        liveSpotPx: 1.1622,
        legOutrightPx: 1.1694,
      }),
    ).toBe(1.1694);
  });

  it('does not treat a bullet forward as a blocked strip pad', () => {
    expect(
      stripLevelNeedsSpotReset({
        structure: 'bullet',
        instrument: 'forward',
        legCount: 1,
      }),
    ).toBe(false);
    expect(
      stripLevelCanPlace({
        structure: 'bullet',
        instrument: 'forward',
        legCount: 0,
      }),
    ).toBe(true);
  });

  it('keeps a selected strip FWD leg on its points-based outright', () => {
    expect(
      clickTradePadResetsToSpot({
        ...stripFwd,
        selectedLegKey: 'leg-0-0',
      }),
    ).toBe(false);
  });

  it('keeps an unselected strip FWD pad on FWD — Spot is not a strip contract', () => {
    expect(
      clickTradePadResetsToSpot({
        ...stripFwd,
        selectedLegKey: null,
      }),
    ).toBe(false);
  });
});

describe('bookedForwardFromSpotFill', () => {
  it('books a spot-executed EUR leg at the spot print plus its stamped points', () => {
    // Hand check: 1.16252 + 156.8 pips = 1.16252 + 0.01568 = 1.17820
    const booked = bookedForwardFromSpotFill({ fillPx: 1.16252, points: 156.8, ccy: 'EUR' });
    expect(booked).toBeCloseTo(1.1782, 9);
  });

  it('applies the JPY /100 convention', () => {
    const booked = bookedForwardFromSpotFill({ fillPx: 147.25, points: -120, ccy: 'JPY' });
    expect(booked).toBeCloseTo(146.05, 9);
  });

  it('refuses to dress a spot fill up as a forward when the points are unknown', () => {
    expect(bookedForwardFromSpotFill({ fillPx: 1.16252, points: null, ccy: 'EUR' })).toBeNull();
    expect(bookedForwardFromSpotFill({ fillPx: 1.16252, points: undefined, ccy: 'EUR' })).toBeNull();
    expect(bookedForwardFromSpotFill({ fillPx: 1.16252, points: Number.NaN, ccy: 'EUR' })).toBeNull();
    expect(bookedForwardFromSpotFill({ fillPx: 1.16252, points: 0, ccy: 'EUR' })).toBeNull();
    expect(bookedForwardFromSpotFill({ fillPx: null, points: 156.8, ccy: 'EUR' })).toBeNull();
  });

  it('keeps the booked forward exact where float addition drifts', () => {
    // Hand check: 1.16529 + 42.01 pips = 1.16529 + 0.004201 = 1.169491.
    // Native float addition returns 1.1694909999999998 for the same inputs.
    expect(bookedForwardFromSpotFill({ fillPx: 1.16529, points: 42.01, ccy: 'EUR' })).toBe(1.169491);
  });
});

describe('spotTileStripLegFields', () => {
  const m12: StripLegTenor = { instrument: 'forward', tenor: '1y', months: 12, label: 'L5 · M12' };

  const points = { bid: 170.1, ask: 172.4 };

  it('books a forward leg left on the spot tile as that forward, resting on spot', () => {
    expect(spotTileStripLegFields(m12, points, 'bid')).toEqual({
      instrument: 'forward',
      maturity: '1y',
      maturityMonths: 12,
      maturityLabel: 'L5 · M12',
      isSpotReferenced: true,
      stripLegPoints: 170.1,
    });
  });

  it('stamps the points of the side the order executes on', () => {
    // An order filled off the spot ASK books ask points, like a live click on
    // the ask books the ask outright — never the bid points.
    expect(spotTileStripLegFields(m12, points, 'ask')).toMatchObject({
      stripLegPoints: 172.4,
    });
  });

  it('carries the same tenor a live click on that row books', () => {
    expect(spotTileStripLegFields(m12, points, 'bid')).toMatchObject(stripLegTenorFields(m12));
  });

  it('keeps the plain spot shape when there are no points to build the forward from', () => {
    expect(spotTileStripLegFields(m12, { bid: null, ask: null }, 'bid')).toEqual(stripSpotTenorFields());
    expect(spotTileStripLegFields(m12, { bid: undefined, ask: undefined }, 'ask')).toEqual(stripSpotTenorFields());
    expect(spotTileStripLegFields(m12, { bid: 0, ask: 0 }, 'bid')).toEqual(stripSpotTenorFields());
    expect(spotTileStripLegFields(m12, { bid: Number.NaN, ask: 172.4 }, 'bid')).toEqual(stripSpotTenorFields());
  });

  it('never borrows the other side\'s points', () => {
    expect(spotTileStripLegFields(m12, { bid: 170.1, ask: null }, 'ask')).toEqual(stripSpotTenorFields());
  });

  it('leaves a spot leg on spot', () => {
    const spotLeg: StripLegTenor = { instrument: 'spot', tenor: '1w', months: 0, label: 'L1 · Spot' };
    expect(spotTileStripLegFields(spotLeg, { bid: 3.2, ask: 3.4 }, 'bid')).toEqual(stripSpotTenorFields());
  });
});

describe('leaveRateFieldEnabled', () => {
  it('opens for an edit of a working order — pre-armed, so inputs are frozen', () => {
    expect(
      leaveRateFieldEnabled({ locked: false, inputsLocked: true, limitMode: true }),
    ).toBe(true);
  });

  it('opens on a fresh compose pad', () => {
    expect(
      leaveRateFieldEnabled({ locked: false, inputsLocked: false, limitMode: false }),
    ).toBe(true);
  });

  it('stays shut on a finished or read-only pad, whatever the mode', () => {
    expect(
      leaveRateFieldEnabled({ locked: true, inputsLocked: true, limitMode: true }),
    ).toBe(false);
    expect(
      leaveRateFieldEnabled({ locked: true, inputsLocked: false, limitMode: false }),
    ).toBe(false);
  });

  it('stays shut when inputs are frozen outside limit mode', () => {
    expect(
      leaveRateFieldEnabled({ locked: false, inputsLocked: true, limitMode: false }),
    ).toBe(false);
  });
});

describe('stripPadShowsLiveQuote', () => {
  const base = {
    isStrip: true,
    freeLegCount: 3,
    selectedLegKey: 'leg-2-2' as string | null,
    selectedLegIsFree: true,
  };

  it('quotes a free leg live', () => {
    expect(stripPadShowsLiveQuote(base)).toBe(true);
  });

  it('shows the execution on a leg that is no longer the desk\'s to trade', () => {
    expect(stripPadShowsLiveQuote({ ...base, selectedLegIsFree: false })).toBe(false);
  });

  it('quotes the unselected pad live, whatever ticket opened the panel', () => {
    // Reported: opened on a working TP, the unselected tile stayed an order
    // sheet with stale levels instead of the default market state.
    expect(stripPadShowsLiveQuote({ ...base, selectedLegKey: null })).toBe(true);
  });

  it('goes quiet when the strip has nothing left to trade', () => {
    expect(stripPadShowsLiveQuote({ ...base, freeLegCount: 0 })).toBe(false);
    expect(stripPadShowsLiveQuote({ ...base, isStrip: false })).toBe(false);
  });
});
