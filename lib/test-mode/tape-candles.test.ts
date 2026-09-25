import { describe, expect, it } from 'vitest';
import type { UTCTimestamp } from 'lightweight-charts';
import {
  SPOT_DAY_MAX_WINDOW_MS,
  aggregateTapeCandles,
  appendLiveTapeTick,
  capTapeHistory,
  tapeCandleGaps,
  chartPriceRangeWithLevels,
  dropTapeConventionBreak,
  TAPE_CONVENTION_BREAK_MAX_GAP_MS,
  foldSpotDayTick,
  holdChartPriceRange,
  isCurrentOverlayTapeFill,
  isSpotDayCandle,
  liveTapeQuoteForOrder,
  localDayStartMs,
  overlayOpenTapeTrail,
  overlayTapeConventionLabel,
  pickTapeBarSec,
  placementMarkFromTrail,
  quoteIsWrongTapeForOrder,
  restingTapeAnchorMid,
  retainTicketOverlayKey,
  snapMsToTapeBar,
  spotDayCandlesToPremiumTicks,
  spotDayCandlesToTapeTicks,
  stabilizeTapeBarSec,
  tapeFillPrint,
  linearTapeInstrument,
  tapeLookbackLabel,
  tapeLookbackStartMs,
  tapeQuoteKey,
  tapeQuoteKeyCandidates,
  widenCandlesToFills,
  withFillPrints,
} from '@/lib/test-mode/tape-candles';

const t0 = 1_700_000_000_000;

function tick(mid: number, atMs: number) {
  return { bid: mid - 0.0001, ask: mid + 0.0001, mid, t: atMs };
}

describe('aggregateTapeCandles', () => {
  it('folds 1s prints into one 5s OHLC whose shape is the path', () => {
    const ticks = [
      tick(1.1, t0 + 0),
      tick(1.12, t0 + 1000),
      tick(1.08, t0 + 2000),
      tick(1.09, t0 + 3000),
      tick(1.11, t0 + 4000),
    ];
    const bars = aggregateTapeCandles(ticks, 5);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.time).toBe(t0 / 1000);
    expect(bars[0]!.open).toBe(1.1);
    // The bar is one series: high and low are the mid path's own extremes, so
    // every drawn price is one the tape printed at.
    expect(bars[0]!.close).toBe(1.11);
    expect(bars[0]!.high).toBe(ticks[1]!.mid);
    expect(bars[0]!.low).toBe(ticks[2]!.mid);
  });

  it('draws no wick on a bar whose mid never moved', () => {
    // The reported defect: high came from the best ask and low from the best
    // bid, so a bar that never moved still grew a half-spread tick above and
    // below its body — at prices nothing traded at.
    const flat = [tick(1.16, t0 + 0), tick(1.16, t0 + 1000), tick(1.16, t0 + 2000)];
    const bar = aggregateTapeCandles(flat, 5)[0]!;
    expect(bar.open).toBe(1.16);
    expect(bar.close).toBe(1.16);
    expect(bar.high).toBe(1.16);
    expect(bar.low).toBe(1.16);
  });

  it('opens a new candle on the next 5s boundary and does not rewrite the last', () => {
    const first = [
      tick(1.1, t0 + 0),
      tick(1.12, t0 + 1000),
      tick(1.08, t0 + 2000),
      tick(1.09, t0 + 3000),
      tick(1.11, t0 + 4000),
    ];
    const closed = aggregateTapeCandles(first, 5)[0]!;
    const next = tick(1.13, t0 + 5000);
    const withNext = aggregateTapeCandles([...first, next], 5);
    expect(withNext).toHaveLength(2);
    expect(withNext[0]).toEqual(closed);
    expect(withNext[1]!.time).toBe(t0 / 1000 + 5);
    expect(withNext[1]!.open).toBe(closed.close);
    expect(withNext[1]!.close).toBe(1.13);
    expect(withNext[1]!.high).toBe(next.mid);
    // The bar opened below its only print, so the open floors the wick.
    expect(withNext[1]!.low).toBe(closed.close);
  });

  it('reads only the mid, so a crossed or missing side cannot distort the bar', () => {
    const ticks = [
      { bid: 1.1005, ask: 1.0995, mid: 1.1, t: t0 + 0 },
      { bid: Number.NaN, ask: Number.NaN, mid: 1.101, t: t0 + 1000 },
    ];
    const bar = aggregateTapeCandles(ticks, 5)[0]!;
    expect(bar.low).toBe(1.1);
    expect(bar.high).toBe(1.101);
    expect(bar.low).toBeLessThanOrEqual(bar.high);
  });

  it('snaps a fill timestamp onto the 5s bar that contains it', () => {
    const ticks = [
      tick(1.1, t0 + 0),
      tick(1.11, t0 + 4000),
      tick(1.13, t0 + 5000),
    ];
    const bars = aggregateTapeCandles(ticks, 5);
    const times = bars.map(b => Number(b.time));
    // 1.7s into the first bar — not on a 5s unix boundary if we used floor(ms/1000)
    expect(snapMsToTapeBar(t0 + 1700, 5, times)).toBe(bars[0]!.time);
    expect(snapMsToTapeBar(t0 + 5200, 5, times)).toBe(bars[1]!.time);
    expect(Math.floor((t0 + 1700) / 1000)).not.toBe(bars[0]!.time);
  });

  it('starts each new candle at the previous close', () => {
    const bars = aggregateTapeCandles(
      [
        tick(1.1, t0),
        tick(1.12, t0 + 4000),
        tick(1.15, t0 + 5000),
        tick(1.09, t0 + 9000),
        tick(1.1, t0 + 10_000),
      ],
      5,
    );
    expect(bars).toHaveLength(3);
    expect(bars[1]!.open).toBe(bars[0]!.close);
    expect(bars[2]!.open).toBe(bars[1]!.close);
  });

  it('does not paint a 170-pip spike when spot ticks jump to the outright', () => {
    const ticks = [
      tick(1.1523, t0),
      tick(1.1524, t0 + 1000),
      tick(1.16936, t0 + 2000),
      tick(1.16940, t0 + 3000),
    ];
    const kept = dropTapeConventionBreak(ticks);
    expect(kept.map(p => p.mid)).toEqual([1.16936, 1.1694]);
    const bars = aggregateTapeCandles(kept, 5);
    expect(bars[0]!.high - bars[0]!.low).toBeLessThan(0.001);
  });

  it('keeps tape recorded before a gap the market moved across', () => {
    // The recorder stops whenever nothing references the currency and stalls
    // on store I/O; spot drifts past 40 pips over minutes of silence. That is
    // one tape with a hole, not two conventions, so the morning survives.
    const ticks = [
      tick(1.1523, t0),
      tick(1.1524, t0 + 1000),
      tick(1.1601, t0 + 11 * 60_000),
      tick(1.1602, t0 + 11 * 60_000 + 1000),
    ];
    expect(dropTapeConventionBreak(ticks).map(p => p.mid)).toEqual([
      1.1523, 1.1524, 1.1601, 1.1602,
    ]);
  });

  it('still cuts a convention jump between prints one beat apart', () => {
    const ticks = [
      tick(1.1523, t0),
      tick(1.16936, t0 + TAPE_CONVENTION_BREAK_MAX_GAP_MS),
      tick(1.16940, t0 + TAPE_CONVENTION_BREAK_MAX_GAP_MS + 1000),
    ];
    expect(dropTapeConventionBreak(ticks).map(p => p.mid)).toEqual([
      1.16936, 1.1694,
    ]);
  });

  it('drops a contaminating stretch and keeps the spot either side of it', () => {
    // A forward leg wrote its outright onto the shared spot key while it was
    // watched, then stopped. The excursion goes; the morning stays.
    const ticks = [
      tick(1.1410, t0),
      tick(1.1411, t0 + 1000),
      tick(1.1698, t0 + 2000),
      tick(1.1699, t0 + 3000),
      tick(1.1412, t0 + 4000),
      tick(1.1413, t0 + 5000),
    ];
    expect(dropTapeConventionBreak(ticks).map(p => p.mid)).toEqual([
      1.141, 1.1411, 1.1412, 1.1413,
    ]);
  });

  it('drops every excursion when the same key is contaminated repeatedly', () => {
    const ticks = [
      tick(1.1410, t0),
      tick(1.1465, t0 + 1000), // short-tenor outright, just past the band
      tick(1.1411, t0 + 2000),
      tick(1.1698, t0 + 3000), // long-tenor outright
      tick(1.1412, t0 + 4000),
    ];
    expect(dropTapeConventionBreak(ticks).map(p => p.mid)).toEqual([
      1.141, 1.1411, 1.1412,
    ]);
  });

  it('still drops the old convention when the tape switches for good', () => {
    const ticks = [
      tick(1.1523, t0),
      tick(1.1524, t0 + 1000),
      tick(1.16936, t0 + 2000),
      tick(1.16940, t0 + 3000),
    ];
    expect(dropTapeConventionBreak(ticks).map(p => p.mid)).toEqual([
      1.16936, 1.1694,
    ]);
  });

  it('cuts on the first jump it can attribute, not the last gap', () => {
    // A convention switch, then a recording gap. Only the switch is a break,
    // so everything after it — both sides of the gap — is kept.
    const ticks = [
      tick(1.1523, t0),
      tick(1.16936, t0 + 1000),
      tick(1.16940, t0 + 2000),
      tick(1.1780, t0 + 9 * 60_000),
    ];
    expect(dropTapeConventionBreak(ticks).map(p => p.mid)).toEqual([
      1.16936, 1.1694, 1.178,
    ]);
  });

  it('updates only close/high/low of the forming bar as ticks arrive', () => {
    const top = tick(1.14, t0 + 1000);
    const bottom = tick(1.07, t0 + 2000);
    const a = aggregateTapeCandles([tick(1.1, t0), top], 5);
    expect(a[0]!.open).toBe(1.1);
    expect(a[0]!.high).toBe(top.mid);
    expect(a[0]!.close).toBe(1.14);
    const b = aggregateTapeCandles([tick(1.1, t0), top, bottom], 5);
    expect(b).toHaveLength(1);
    expect(b[0]!.open).toBe(1.1);
    expect(b[0]!.high).toBe(top.mid);
    expect(b[0]!.low).toBe(bottom.mid);
    expect(b[0]!.close).toBe(1.07);
  });
});

describe('widenCandlesToFills', () => {
  it('refuses to widen a bar to a fill from another convention', () => {
    // The reported chart: a 1m bar at ~1.1478 dragged down to a spot TP pin
    // at 1.14417 — 36 pips — twice in one series, so two candles ran the full
    // height of the plot and the axis blew out for every other bar. 36 pips
    // is under TAPE_MAX_JUMP_PIPS (40), so the continuity band does not catch
    // it; the widen needs its own, much tighter bound.
    const bars = [
      { time: 100 as UTCTimestamp, open: 1.1478, high: 1.14785, low: 1.14775, close: 1.1478 },
    ];
    const drawn = widenCandlesToFills(bars, [
      { time: 100 as UTCTimestamp, price: 1.14417 },
    ]);
    expect(drawn[0]!.low).toBe(1.14775);
    expect(drawn[0]).toBe(bars[0]);
  });

  it('still widens to a fill just outside its own bar', () => {
    // The case the function exists for: the print sits a fraction of the
    // spread below a mid bar, so the bar must reach it.
    const bars = [
      { time: 100 as UTCTimestamp, open: 1.1478, high: 1.14785, low: 1.14775, close: 1.1478 },
    ];
    const drawn = widenCandlesToFills(bars, [
      { time: 100 as UTCTimestamp, price: 1.14773 },
    ]);
    expect(drawn[0]!.low).toBeCloseTo(1.14773, 10);
  });

  it('one out-of-convention fill does not block a genuine one on the same bar', () => {
    const bars = [
      { time: 100 as UTCTimestamp, open: 1.1478, high: 1.14785, low: 1.14775, close: 1.1478 },
    ];
    const drawn = widenCandlesToFills(bars, [
      { time: 100 as UTCTimestamp, price: 1.14417 },
      { time: 100 as UTCTimestamp, price: 1.14773 },
    ]);
    expect(drawn[0]!.low).toBeCloseTo(1.14773, 10);
  });

  // The defect this exists for: a sell-EUR stop at 1.16230 fills on the BID at
  // 1.16228 while the mid is 1.16238, so on a mid candle the print sits below
  // the bar it happened in and the desk reads a chart that never reached the
  // level it triggered on.
  const stopLevel = 1.1623;
  const ticks = [
    tick(1.16246, t0 + 0),
    tick(1.16238, t0 + 1000),
    tick(1.16251, t0 + 2000),
  ];
  const fillPx = ticks[1]!.bid;

  it('pulls the bar down to a bid-side fill it would otherwise miss', () => {
    expect(fillPx).toBeLessThanOrEqual(stopLevel);
    const bars = aggregateTapeCandles(ticks, 5);
    expect(bars[0]!.low).toBeGreaterThan(fillPx);
    const drawn = widenCandlesToFills(bars, [
      { time: bars[0]!.time, price: fillPx },
    ]);
    expect(drawn[0]!.low).toBeLessThanOrEqual(fillPx);
    expect(drawn[0]!.low).toBeLessThanOrEqual(stopLevel);
    // Only the side the fill needed moves; the rest of the bar is untouched.
    expect(drawn[0]!.high).toBe(bars[0]!.high);
    expect(drawn[0]!.open).toBe(bars[0]!.open);
    expect(drawn[0]!.close).toBe(bars[0]!.close);
  });

  it('leaves every bar that holds no fill exactly as the mid path drew it', () => {
    const bars = aggregateTapeCandles(
      [tick(1.1, t0), tick(1.12, t0 + 4000), tick(1.15, t0 + 5000)],
      5,
    );
    // Just outside bars[1]; a fill further than TAPE_FILL_WIDEN_MAX_PIPS is
    // refused, and this test is about the untouched bar keeping identity.
    const drawn = widenCandlesToFills(bars, [
      { time: bars[1]!.time, price: 1.1502 },
    ]);
    expect(drawn[0]).toBe(bars[0]);
    expect(drawn[1]!.high).toBeCloseTo(1.1502, 10);
  });

  it('ignores a fill with no usable price and keeps the array identity', () => {
    const bars = aggregateTapeCandles([tick(1.1, t0), tick(1.12, t0 + 1000)], 5);
    expect(widenCandlesToFills(bars, [])).toBe(bars);
    expect(
      widenCandlesToFills(bars, [{ time: bars[0]!.time, price: Number.NaN }]),
    ).toBe(bars);
    expect(widenCandlesToFills(bars, [{ time: bars[0]!.time, price: 0 }])).toBe(bars);
  });

  it('takes the widest reach when one bar holds several fills', () => {
    const bars = aggregateTapeCandles([tick(1.1, t0), tick(1.11, t0 + 1000)], 5);
    // Both within the widen budget; this test is about taking the widest
    // reach across several fills on one bar, not about how far they may sit.
    const drawn = widenCandlesToFills(bars, [
      { time: bars[0]!.time, price: 1.0997 },
      { time: bars[0]!.time, price: 1.1103 },
    ]);
    expect(drawn[0]!.low).toBeCloseTo(1.0997, 10);
    expect(drawn[0]!.high).toBeCloseTo(1.1103, 10);
  });
});

describe('pickTapeBarSec', () => {
  it('stays on 5s for a few minutes of tape', () => {
    expect(pickTapeBarSec(6 * 60)).toBe(5);
    expect(pickTapeBarSec(10 * 60)).toBe(5);
  });

  it('steps to 1m / 5m / 15m when the window is hours', () => {
    expect(pickTapeBarSec(2 * 3600)).toBe(60);
    expect(pickTapeBarSec(6 * 3600)).toBe(300);
    expect(pickTapeBarSec(18 * 3600)).toBe(900);
  });

  it('does not flicker at the boundary while zooming', () => {
    expect(stabilizeTapeBarSec(5, 12 * 60)).toBe(5);
    expect(stabilizeTapeBarSec(5, 20 * 60)).toBe(15);
    expect(stabilizeTapeBarSec(60, 6 * 3600)).toBe(300);
    expect(stabilizeTapeBarSec(300, 90 * 60)).toBe(60);
  });
});

describe('restingTapeAnchorMid', () => {
  it('uses the forward outright, not a spot print 170 pips away', () => {
    expect(
      restingTapeAnchorMid({
        limitRate: 1.169,
        restingAnchorRate: 1.15231,
        ipaQuote: { fxOutright: 1.16936, fxSpot: 1.15231 },
      }),
    ).toBe(1.16936);
  });

  it('uses the limit when rest is missing or is a spot print', () => {
    expect(
      restingTapeAnchorMid({
        limitRate: 1.17745,
      }),
    ).toBe(1.17745);
    expect(
      restingTapeAnchorMid({
        limitRate: 1.169,
        restingAnchorRate: 1.15231,
      }),
    ).toBe(1.169);
  });
});

describe('quoteIsWrongTapeForOrder', () => {
  const spot = { bid: 1.1525, ask: 1.1527, mid: 1.1526 };
  const forward = { bid: 1.1692, ask: 1.1694, mid: 1.1693 };

  it('rejects a spot print against a forward stop even when the tile mid is the outright', () => {
    expect(
      quoteIsWrongTapeForOrder(
        {
          limitRate: 1.169,
          restingAnchorRate: 1.16936,
          ipaQuote: { fxSpot: 1.15231, fxOutright: 1.16936 },
        },
        spot,
      ),
    ).toBe(true);
  });

  it('rejects engine spot when only the IPA outright fingerprints the forward tape', () => {
    expect(
      quoteIsWrongTapeForOrder(
        {
          limitRate: 1.169,
          restingAnchorRate: 1.16936,
          ipaQuote: { fxOutright: 1.16936 },
        },
        spot,
      ),
    ).toBe(true);
  });

  it('allows a same-tape print through the limit', () => {
    expect(
      quoteIsWrongTapeForOrder(
        { limitRate: 1.16, restingAnchorRate: 1.17 },
        { bid: 1.18, ask: 1.1802, mid: 1.1801 },
      ),
    ).toBe(false);
    expect(
      quoteIsWrongTapeForOrder(
        { limitRate: 1.16, restingAnchorRate: 1.161 },
        { bid: 1.162, ask: 1.1622, mid: 1.1621 },
      ),
    ).toBe(false);
    expect(quoteIsWrongTapeForOrder({ limitRate: 1.169 }, forward)).toBe(false);
  });

  it('rejects spot vs a 9m stop that has no IPA and no rest stamp', () => {
    expect(
      quoteIsWrongTapeForOrder(
        { limitRate: 1.17745 },
        { bid: 1.1525, ask: 1.1526, mid: 1.15254 },
      ),
    ).toBe(true);
  });

  it('rejects spot vs a forward stop left from the outright tile with no IPA', () => {
    expect(
      quoteIsWrongTapeForOrder(
        { limitRate: 1.157, restingAnchorRate: 1.1575 },
        { bid: 1.1525, ask: 1.1526, mid: 1.15255 },
      ),
    ).toBe(true);
    expect(
      quoteIsWrongTapeForOrder(
        { limitRate: 1.169, restingAnchorRate: 1.16936 },
        { bid: 1.1525, ask: 1.1526, mid: 1.15255 },
      ),
    ).toBe(true);
  });
});

describe('tapeQuoteKey', () => {
  it('does not bucket 6.3m and 8.2m strip legs onto the same 9m tape', () => {
    const l3 = {
      ccy: 'EUR',
      instrument: 'forward' as const,
      maturity: '9m',
      maturityMonths: 6.3,
      stripId: 's1',
      stripEdgeIndex: 2,
    };
    const l8 = {
      ccy: 'EUR',
      instrument: 'forward' as const,
      maturity: '9m',
      maturityMonths: 8.2,
      stripId: 's1',
      stripEdgeIndex: 7,
    };
    expect(tapeQuoteKey(l3)).not.toBe(tapeQuoteKey(l8));
    expect(tapeQuoteKey(l3)).toContain('t6.30');
    expect(tapeQuoteKey(l8)).toContain('t8.20');
  });

  it('routes every spot-referencing ticket to one canonical spot tape per ccy', () => {
    const stripSpotLeg = {
      ccy: 'EUR',
      instrument: 'spot' as const,
      maturity: null,
      maturityMonths: 0,
      stripId: 's1',
      stripEdgeIndex: 2,
    };
    const spotBracket = {
      ccy: 'eur',
      instrument: 'spot' as const,
      maturity: '1m',
    };
    const plainSpot = { ccy: 'EUR' };
    expect(tapeQuoteKey(stripSpotLeg)).toBe('EUR|spot');
    expect(tapeQuoteKey(spotBracket)).toBe('EUR|spot');
    expect(tapeQuoteKey(plainSpot)).toBe('EUR|spot');
    expect(tapeQuoteKey({ ccy: 'PLN', instrument: 'spot' })).toBe('PLN|spot');
  });

  it('keys a forward leg whose order rests on spot on the spot tape, not its outright', () => {
    const restsOnSpot: Parameters<typeof tapeQuoteKeyCandidates>[0] = {
      ccy: 'EUR',
      instrument: 'forward',
      isSpotReferenced: true,
      maturity: '1y',
      maturityMonths: 12,
      stripId: 's1',
      stripEdgeIndex: 4,
    };
    expect(tapeQuoteKey(restsOnSpot)).toBe('EUR|spot');
    expect(tapeQuoteKeyCandidates(restsOnSpot)).toEqual(['EUR|spot']);
    expect(overlayTapeConventionLabel(restsOnSpot)).toBe('spot');
    // The same leg booked by a live click lives on its own outright.
    expect(tapeQuoteKey({ ...restsOnSpot, isSpotReferenced: false })).toBe('EUR|forward|t12.00');
  });

  it('draws a spot-referenced forward\'s fill at its spot execution, not its booked rate', () => {
    const ipaQuote = { fxSpot: 1.1625, fxOutright: 1.17951 };
    expect(tapeFillPrint({ isSpotReferenced: true, ipaQuote })).toBe(1.1625);
    expect(tapeFillPrint({ ipaQuote })).toBe(1.17951);
    expect(tapeFillPrint({ isSpotReferenced: true, ipaQuote: null })).toBeNull();
  });
});

describe('retainTicketOverlayKey', () => {
  it('keeps the Book session key when the filled ticket gets a new id', () => {
    expect(retainTicketOverlayKey('book:compose-1', 'filled-9', 'keep')).toBe(
      'book:compose-1',
    );
    expect(retainTicketOverlayKey('book:compose-1', 'rest-2', 'keep')).toBe(
      'book:compose-1',
    );
  });

  it('remounts only when opening Book, blotter view, or Edit', () => {
    expect(retainTicketOverlayKey(null, 'c1', 'book')).toBe('book:c1');
    expect(retainTicketOverlayKey('book:c1', 'old-strip', 'view')).toBe(
      'tape:old-strip',
    );
    expect(retainTicketOverlayKey('tape:w1', 'w1', 'edit')).toBe('tape:w1:edit');
  });
});

describe('liveTapeQuoteForOrder', () => {
  const fwd = {
    instrument: 'forward' as const,
    limitRate: 1.177,
    restingAnchorRate: 1.1784,
    ipaQuote: { fxOutright: 1.1784, fxSpot: 1.1648 },
  };

  it('rejects a spot-priced pad on a 3M forward and stays on the outright', () => {
    const q = liveTapeQuoteForOrder(
      fwd,
      { bid: 1.16486, ask: 1.16488 },
      { bid: 1.16486, ask: 1.16488, mid: 1.16487 },
    );
    expect(q).not.toBeNull();
    expect(q!.mid).toBeGreaterThan(1.17);
    expect(q!.mid).toBeLessThan(1.19);
    expect(Math.abs(q!.mid - 1.16487)).toBeGreaterThan(0.005);
  });

  it('uses a priced 3M outright on a draft Book ticket with no limit yet', () => {
    const q = liveTapeQuoteForOrder(
      { instrument: 'forward' },
      { bid: 1.1783, ask: 1.1785 },
      { bid: 1.16486, ask: 1.16488, mid: 1.16487 },
    );
    expect(q?.mid).toBeCloseTo(1.1784);
  });

  it('walks the outright when fx-spot is the only pad on a parked forward', () => {
    const q = liveTapeQuoteForOrder(
      {
        instrument: 'forward',
        limitRate: 1.177,
        ipaQuote: { fxOutright: 1.1784, fxSpot: 1.1648 },
      },
      { bid: 1.16486, ask: 1.16488 },
      { bid: 1.16486, ask: 1.16488, mid: 1.16487 },
    );
    expect(q).not.toBeNull();
    expect(q!.mid).toBeGreaterThan(1.17);
  });

  it('uses the priced outright when it is the same tape as the order', () => {
    const q = liveTapeQuoteForOrder(
      fwd,
      { bid: 1.1783, ask: 1.1785 },
      { bid: 1.16486, ask: 1.16488, mid: 1.16487 },
    );
    expect(q?.bid).toBeCloseTo(1.1783);
    expect(q?.ask).toBeCloseTo(1.1785);
  });

  it('trusts a fresh outright even when it has drifted far from an old, already-filled anchor', () => {
    // Reopening a forward that filled long ago: its own stored anchor
    // (1.1784) is stale, and the market has genuinely moved since. A fresh
    // re-priced outright (1.2050) is not spot mistaken for a forward — it's
    // just today's price — so LIVE REF must show it directly, the same
    // formula used before the order was ever placed, not roll the old fill
    // price forward by the spot delta.
    const filledLongAgo = {
      instrument: 'forward' as const,
      limitRate: 1.177,
      restingAnchorRate: 1.1784,
      ipaQuote: { fxOutright: 1.1784, fxSpot: 1.1648 },
    };
    const q = liveTapeQuoteForOrder(
      filledLongAgo,
      { bid: 1.2049, ask: 1.2051 },
      { bid: 1.1899, ask: 1.1901, mid: 1.19 },
    );
    expect(q?.bid).toBeCloseTo(1.2049);
    expect(q?.ask).toBeCloseTo(1.2051);
  });
});

describe('appendLiveTapeTick', () => {
  it('keeps appending so 5s candles walk before any BID/ASK click', () => {
    const a = appendLiveTapeTick([], tick(1.1784, t0));
    const b = appendLiveTapeTick(a, tick(1.1785, t0 + 1000));
    expect(b).toHaveLength(2);
    expect(b[1]!.mid).toBeCloseTo(1.1785);
  });

  it('starts a new series on a spot↔outright jump instead of freezing', () => {
    const frozen = appendLiveTapeTick(
      [tick(1.1648, t0)],
      tick(1.1784, t0 + 1000),
    );
    expect(frozen).toHaveLength(1);
    expect(frozen[0]!.mid).toBeCloseTo(1.1784);
  });
});

describe('overlayOpenTapeTrail', () => {
  it('drops leftover spot history on a new Book overlay', () => {
    const hist = [tick(1.1648, t0), tick(1.1649, t0 + 1000)];
    expect(overlayOpenTapeTrail(hist, { mid: 1.1784 }, true)).toEqual([]);
    expect(overlayOpenTapeTrail(hist, null, true)).toEqual([]);
  });

  it('keeps same-tape history when reopening from the blotter', () => {
    const hist = [tick(1.1783, t0), tick(1.1784, t0 + 1000)];
    expect(overlayOpenTapeTrail(hist, { mid: 1.1785 }, false)).toHaveLength(2);
  });
});

describe('overlayTapeConventionLabel', () => {
  it('names the 3M outright, not spot', () => {
    expect(
      overlayTapeConventionLabel({ instrument: 'forward', maturityMonths: 3 }),
    ).toBe('3M outright');
    expect(overlayTapeConventionLabel({ instrument: 'spot' })).toBe('spot');
  });
});

describe('isCurrentOverlayTapeFill', () => {
  it('hides a previous-session strip fill on a new Book overlay', () => {
    expect(
      isCurrentOverlayTapeFill(1_700_000_000_000, {
        bookSession: true,
        overlayOpenedAtMs: 1_800_000_000_000,
      }),
    ).toBe(false);
  });

  it('keeps a fill that happened after Book opened', () => {
    expect(
      isCurrentOverlayTapeFill(1_800_000_100_000, {
        bookSession: true,
        overlayOpenedAtMs: 1_800_000_000_000,
      }),
    ).toBe(true);
  });

  it('still shows historical fills when opened from the blotter', () => {
    expect(
      isCurrentOverlayTapeFill(1_700_000_000_000, {
        bookSession: false,
        overlayOpenedAtMs: 1_800_000_000_000,
      }),
    ).toBe(true);
  });

  it('keeps a fill the drawn story covers, however late the overlay opened', () => {
    // Booking reopened 3 minutes after it filled: the trail is the recorded
    // story (a lead before the fill through fill + tail), so the pin belongs.
    const fill = 1_800_000_000_000;
    expect(
      isCurrentOverlayTapeFill(fill, {
        bookSession: true,
        overlayOpenedAtMs: fill + 180_000,
        trailStartMs: fill - 60_000,
      }),
    ).toBe(true);
  });

  it('still drops a fill from before the drawn story', () => {
    const trailStart = 1_800_000_000_000;
    expect(
      isCurrentOverlayTapeFill(trailStart - 3_600_000, {
        bookSession: true,
        overlayOpenedAtMs: trailStart,
        trailStartMs: trailStart,
      }),
    ).toBe(false);
  });
});

describe('placementMarkFromTrail', () => {
  const trail = [
    { mid: 1.1701, t: t0 + 0 },
    { mid: 1.1705, t: t0 + 5000 },
    { mid: 1.1699, t: t0 + 10000 },
  ];

  it('pins the anchor rate at the first recorded timestamp', () => {
    const mark = placementMarkFromTrail({ restingAnchorRate: 1.1712 }, trail);
    expect(mark).toEqual({ t: t0, px: 1.1712 });
  });

  it('falls back to the opening mid when the order has no anchor', () => {
    const mark = placementMarkFromTrail({ restingAnchorRate: null }, trail);
    expect(mark).toEqual({ t: t0, px: 1.1701 });
  });

  it('falls back to the opening mid when the anchor is a convention break away', () => {
    // 1.34 vs a 1.17 trail is the wrong tape for this order — keep the pin on chart.
    const mark = placementMarkFromTrail({ restingAnchorRate: 1.34 }, trail);
    expect(mark).toEqual({ t: t0, px: 1.1701 });
  });

  it('returns null when the leg has no tape history yet', () => {
    expect(placementMarkFromTrail({ restingAnchorRate: 1.1712 }, [])).toBeNull();
  });

  it('pins at the first print at or after the placement instant, not the record start', () => {
    const trail = [
      { mid: 1.17, t: t0 },
      { mid: 1.171, t: t0 + 60_000 },
      { mid: 1.172, t: t0 + 120_000 },
    ];
    const pinned = placementMarkFromTrail({ restingAnchorRate: 1.1712 }, trail, t0 + 90_000);
    expect(pinned).toEqual({ t: t0 + 120_000, px: 1.1712 });
    // No print after the instant yet: the newest context point holds the pin.
    const early = placementMarkFromTrail({ restingAnchorRate: 1.1712 }, trail, t0 + 500_000);
    expect(early).toEqual({ t: t0, px: 1.1712 });
  });

  it('skips leading zero / undated points when choosing the placement instant', () => {
    const mark = placementMarkFromTrail({ restingAnchorRate: 1.1712 }, [
      { mid: 0, t: 0 },
      { mid: 1.17, t: t0 + 3000 },
    ]);
    expect(mark).toEqual({ t: t0 + 3000, px: 1.1712 });
  });
});

describe('linearTapeInstrument', () => {
  it('keeps the outright series when the desk toggles Option', () => {
    expect(linearTapeInstrument('forward', 9)).toBe('forward');
    expect(linearTapeInstrument('option', 9)).toBe('forward');
    expect(linearTapeInstrument('spot', 0)).toBe('spot');
    expect(linearTapeInstrument('option', 0)).toBe('spot');
  });
});

describe('tapeQuoteKey tenor normalization', () => {
  it('label and months spellings of one tenor resolve to ONE key', () => {
    // The recorded-fill regression: the runtime persisted a 9M forward's
    // tape under "EUR|forward|9m" (label survived, months did not) while
    // the reopened modal fetched "EUR|forward|t9.00" — 297 recorded rows
    // sat unreadable and the chart opened empty.
    const months = tapeQuoteKey({ ccy: 'EUR', instrument: 'forward', maturityMonths: 9 });
    const label = tapeQuoteKey({ ccy: 'EUR', instrument: 'forward', maturity: '9m' });
    expect(months).toBe('EUR|forward|t9.00');
    expect(label).toBe(months);
    expect(tapeQuoteKey({ ccy: 'EUR', instrument: 'forward', maturity: '1y' }))
      .toBe('EUR|forward|t12.00');
  });

  it('read-side candidates cover the retired label spelling', () => {
    expect(
      tapeQuoteKeyCandidates({ ccy: 'EUR', instrument: 'forward', maturity: '9m' }),
    ).toEqual(['EUR|forward|t9.00', 'EUR|forward|9m']);
    // Spot never had a label form — one canonical key only.
    expect(tapeQuoteKeyCandidates({ ccy: 'EUR', instrument: 'spot' }))
      .toEqual(['EUR|spot']);
  });
});

describe('spot day record', () => {
  const minute = 60_000;
  // On a 1m, 5m and 15m boundary at once.
  const day0 = 1_700_000_100_000;

  function bar(t: number, open: number, high: number, low: number, close: number) {
    return { t, open, high, low, close, ticks: 60, prints: 3 };
  }

  it('folds prints into a 1m bar whose wick is the mid path', () => {
    const first = foldSpotDayTick(null, tick(1.1623, day0));
    expect(first.closed).toBeNull();
    expect(first.forming).toMatchObject({ t: day0, open: 1.1623, close: 1.1623, ticks: 1 });
    // A single print is a flat bar — not one padded out to its own bid/ask.
    expect(first.forming!.high).toBeCloseTo(1.1623, 9);
    expect(first.forming!.low).toBeCloseTo(1.1623, 9);

    const second = foldSpotDayTick(first.forming, tick(1.1626, day0 + 20_000));
    expect(second.closed).toBeNull();
    expect(second.forming).toMatchObject({ t: day0, open: 1.1623, close: 1.1626, ticks: 2 });
    expect(second.forming!.high).toBeCloseTo(1.1626, 9);
    expect(second.forming!.low).toBeCloseTo(1.1623, 9);
  });

  it('closes the bar on the next minute and drops a print from an earlier one', () => {
    const { forming } = foldSpotDayTick(null, tick(1.1623, day0));
    const rolled = foldSpotDayTick(forming, tick(1.163, day0 + minute));
    expect(rolled.closed).toMatchObject({ t: day0, ticks: 1 });
    expect(rolled.forming).toMatchObject({
      t: day0 + minute,
      open: 1.163,
      close: 1.163,
      ticks: 1,
    });
    const late = foldSpotDayTick(rolled.forming, tick(1.16, day0 + 30_000));
    expect(late.closed).toBeNull();
    expect(late.forming).toBe(rolled.forming);
  });

  it('counts live prints separately from simulated walk steps', () => {
    const snapped = foldSpotDayTick(null, tick(1.1623, day0), 60, true);
    expect(snapped.forming).toMatchObject({ ticks: 1, prints: 1 });
    const walked = foldSpotDayTick(snapped.forming, tick(1.1624, day0 + 1_000));
    expect(walked.forming).toMatchObject({ ticks: 2, prints: 1 });
    const again = foldSpotDayTick(walked.forming, tick(1.1626, day0 + 2_000), 60, true);
    expect(again.forming).toMatchObject({ ticks: 3, prints: 2 });
    const rolled = foldSpotDayTick(again.forming, tick(1.1626, day0 + minute));
    expect(rolled.closed).toMatchObject({ prints: 2 });
    expect(rolled.forming).toMatchObject({ ticks: 1, prints: 0 });
  });

  it('accepts only a fully numeric bar as a day candle', () => {
    expect(isSpotDayCandle(bar(day0, 1, 2, 0.5, 1.5))).toBe(true);
    expect(isSpotDayCandle({ ...bar(day0, 1, 2, 0.5, 1.5), prints: undefined })).toBe(false);
    expect(isSpotDayCandle({ ...bar(day0, 1, 2, 0.5, 1.5), close: Number.NaN })).toBe(false);
    expect(isSpotDayCandle({ ...bar(day0, 1, 2, 0.5, 1.5), t: '1700000100000' })).toBe(false);
    expect(isSpotDayCandle(null)).toBe(false);
  });

  it('locks the axis around candles and levels with one shared padding', () => {
    const candles = [
      { low: 1.16, high: 1.161 },
      { low: 1.1605, high: 1.1615 },
    ];
    expect(chartPriceRangeWithLevels(candles, [])).toBeNull();
    expect(chartPriceRangeWithLevels(candles, [Number.NaN])).toBeNull();
    // A TP 40 pips above today's range: the range widens to hold it, padded 12%.
    const range = chartPriceRangeWithLevels(candles, [1.1655])!;
    const padding = (1.1655 - 1.16) * 0.12;
    expect(range.min).toBeCloseTo(1.16 - padding, 9);
    expect(range.max).toBeCloseTo(1.1655 + padding, 9);
    // JPY-style rates keep a 0.01 floor on the padding.
    const jpy = chartPriceRangeWithLevels([{ low: 150.01, high: 150.02 }], [150.015])!;
    expect(jpy.min).toBeCloseTo(150.0, 9);
    expect(jpy.max).toBeCloseTo(150.03, 9);
  });

  it('holds the axis still while the market walks onto a level', () => {
    // The level stops pinning the top of the range the moment the market
    // reaches it, and the range is then recomputed from the candles on every
    // tick. Each new high used to rescale the axis, moving every line and
    // marker on the plot.
    const level = 1.165;
    let held: { min: number; max: number } | null = null;
    const tick = (low: number, high: number): { min: number; max: number } => {
      held = holdChartPriceRange(held, chartPriceRangeWithLevels([{ low, high }], [level])!);
      return held;
    };
    const first = tick(1.164, 1.1645);
    expect(tick(1.164, 1.1648)).toBe(first);
    expect(tick(1.1641, 1.165)).toBe(first);
    expect(tick(1.1645, 1.165)).toBe(first);

    // It still follows the market out of the window.
    const out = tick(1.1645, 1.166);
    expect(out).not.toBe(first);
    expect(out.max).toBeGreaterThan(first.max);
  });

  it('re-tightens once a spike has left the window', () => {
    expect(holdChartPriceRange({ min: 1.16, max: 1.17 }, { min: 1.1648, max: 1.1652 }))
      .toEqual({ min: 1.1648, max: 1.1652 });
    // Wider than needed, but not by enough to be worth a rescale.
    const snug = { min: 1.1645, max: 1.1655 };
    expect(holdChartPriceRange(snug, { min: 1.1648, max: 1.1652 })).toBe(snug);
    expect(holdChartPriceRange(null, snug)).toBe(snug);
  });

  it('ignores a print without a positive mid', () => {
    const { forming } = foldSpotDayTick(null, tick(1.1623, day0));
    const bad = foldSpotDayTick(forming, { bid: 0, ask: 0, mid: 0, t: day0 + 1000 });
    expect(bad.forming).toBe(forming);
    expect(bad.closed).toBeNull();
  });

});

describe('capTapeHistory', () => {
  const now = Date.UTC(2026, 8, 16, 0, 0, 0);
  const hour = 3_600_000;
  it("keeps a booking's recorded story, and only the last six hours of live tape", () => {
    // The reported defect: a strip filled two days ago drew on open, then
    // an hour of live EUR|spot pushed its 626 rows past a count cap and the
    // chart went blank.
    const story = [
      { t: now - 48 * hour, mid: 1.159, recorded: true },
      { t: now - 48 * hour + 1000, mid: 1.1591, recorded: true },
    ];
    const live = [
      { t: now - 7 * hour, mid: 1.17 },
      { t: now - 5 * hour, mid: 1.171 },
      { t: now - 1000, mid: 1.172 },
    ];
    const kept = capTapeHistory([...story, ...live], now);
    expect(kept.map(p => p.t)).toEqual([
      story[0]!.t,
      story[1]!.t,
      live[1]!.t,
      live[2]!.t,
    ]);
  });
  it('returns the same array when nothing is evicted', () => {
    const points = [{ t: now - 1000, mid: 1.17 }];
    expect(capTapeHistory(points, now)).toBe(points);
  });
});

describe('tapeLookbackStartMs', () => {
  // The anchor is the order's own placement, which may be days old — a window
  // leads into the order, it is not the hours before now.
  const placement = Date.UTC(2026, 8, 13, 12, 0, 0);
  it('has no start for the order story, and a lead-in or day start before the placement', () => {
    expect(tapeLookbackStartMs('order', placement)).toBeNull();
    expect(tapeLookbackStartMs('1h', placement)).toBe(placement - 3_600_000);
    expect(tapeLookbackStartMs('24h', placement)).toBe(placement - 24 * 3_600_000);
    expect(tapeLookbackStartMs('48h', placement)).toBe(placement - SPOT_DAY_MAX_WINDOW_MS);
    expect(tapeLookbackStartMs('today', placement)).toBe(localDayStartMs(placement));
  });

  it('names the loaded period chips the desk picks besides Interval', () => {
    expect(tapeLookbackLabel('order')).toBe('Order');
    expect(tapeLookbackLabel('1h')).toBe('Last hour');
    expect(tapeLookbackLabel('today')).toBe('Last day');
    expect(tapeLookbackLabel('24h')).toBe('24h');
    expect(tapeLookbackLabel('48h')).toBe('48h');
  });
});

describe('spotDayCandlesToTapeTicks', () => {
  const bar = (t: number, open: number, high: number, low: number, close: number) => ({
    t,
    open,
    high,
    low,
    close,
    ticks: 60,
    prints: 2,
  });

  it('walks open → low → high → close for an up bar, shifted by the leg points', () => {
    // Hand check: spot 1.1600 + 34 pips = 1.1634 at the open.
    const ticks = spotDayCandlesToTapeTicks(
      [bar(t0 + 60_000, 1.16, 1.1605, 1.1595, 1.1602)],
      0.0034,
    );
    expect(ticks.map(p => p.t)).toEqual([
      t0 + 60_000,
      t0 + 80_000,
      t0 + 100_000,
      t0 + 119_000,
    ]);
    expect(ticks.map(p => Number(p.mid.toFixed(6)))).toEqual([
      1.1634, 1.1629, 1.1639, 1.1636,
    ]);
    expect(ticks.every(p => p.bid === p.mid && p.ask === p.mid)).toBe(true);
  });

  it('walks open → high → low → close for a down bar', () => {
    const ticks = spotDayCandlesToTapeTicks([bar(t0, 1.1602, 1.1605, 1.1595, 1.16)], 0);
    expect(ticks.map(p => p.mid)).toEqual([1.1602, 1.1605, 1.1595, 1.16]);
  });

  it('re-aggregates to the 1m OHLC it came from', () => {
    // A record bar starts on its own 1m bucket boundary, as the real ones do.
    const barStart = Math.ceil(t0 / 60_000) * 60_000;
    const ticks = spotDayCandlesToTapeTicks(
      [bar(barStart, 1.16, 1.1605, 1.1595, 1.1602)],
      0,
    );
    const bars = aggregateTapeCandles(ticks, 60);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ open: 1.16, high: 1.1605, low: 1.1595, close: 1.1602 });
  });

  it('skips a malformed bar', () => {
    const broken = { ...bar(t0, 1.16, 1.1605, 1.1595, 1.16), open: Number.NaN };
    expect(spotDayCandlesToTapeTicks([broken], 0)).toEqual([]);
  });
});

describe('spotDayCandlesToPremiumTicks', () => {
  const bar = (t: number, open: number, high: number, low: number, close: number) => ({
    t,
    open,
    high,
    low,
    close,
    ticks: 60,
    prints: 2,
  });

  it('walks premium by sticky delta × notional × USD-per-FCY move', () => {
    const ticks = spotDayCandlesToPremiumTicks(
      [bar(t0 + 60_000, 1.16, 1.1605, 1.1595, 1.1602)],
      {
        spotNow: 1.16,
        premiumNow: 10_000,
        deltaFrac: 0.5,
        notionalFcy: 1_000_000,
        quotedUsdPerFcy: true,
      },
    );
    expect(ticks.map(p => p.t)).toEqual([
      t0 + 60_000,
      t0 + 80_000,
      t0 + 100_000,
      t0 + 119_000,
    ]);
    // Up bar path: open → low → high → close. dS = 0, −0.0005, +0.0005, +0.0002
    // → $0 / −$250 / $250 / $100 on 0.5 Δ × $1m.
    expect(ticks.map(p => Math.round(p.mid))).toEqual([10_000, 9_750, 10_250, 10_100]);
  });

  it('uses 1/S for pairs quoted FCY per USD', () => {
    const ticks = spotDayCandlesToPremiumTicks(
      [bar(t0, 151, 151, 151, 151)],
      {
        spotNow: 150,
        premiumNow: 10_000,
        deltaFrac: 0.5,
        notionalFcy: 1_000_000,
        quotedUsdPerFcy: false,
      },
    );
    const dUsd = 1 / 151 - 1 / 150;
    expect(ticks[0]!.mid).toBeCloseTo(10_000 + 0.5 * 1_000_000 * dUsd, 5);
  });
});

describe('recording gaps', () => {
  // Timestamps must be real epoch ms: tickTimeMs reads small numbers as
  // SECONDS, which puts every tick in its own bucket.
  it('opens the bar after a gap at its own print, not the pre-gap close', () => {
    // The defect this exists for: the desk closed the ticket at 1.1526, the
    // market moved while nothing recorded, and recording resumed at 1.1492.
    // Chaining opened the resuming bar at 1.1526 and drew one 34-pip candle
    // that no market ever printed.
    const candles = aggregateTapeCandles(
      [
        tick(1.1525, t0),
        tick(1.1526, t0 + 1000),
        tick(1.1492, t0 + 10_000_000),
        tick(1.1493, t0 + 10_001_000),
      ],
      5,
    );
    expect(candles).toHaveLength(2);
    expect(candles[0]!.close).toBeCloseTo(1.1526, 6);
    expect(candles[1]!.open).toBeCloseTo(1.1492, 6);
    expect(candles[1]!.high).toBeCloseTo(1.1493, 6);
    expect(candles[1]!.low).toBeCloseTo(1.1492, 6);
  });

  it('still chains across a single empty bucket — a quiet market is not a gap', () => {
    const candles = aggregateTapeCandles(
      [tick(1.15, t0), tick(1.1502, t0 + 10_000)],
      5,
    );
    expect(candles).toHaveLength(2);
    expect(candles[1]!.open).toBeCloseTo(1.15, 6);
  });

  it('reports no gap for a continuous series', () => {
    const candles = aggregateTapeCandles(
      [tick(1.15, t0), tick(1.1501, t0 + 5000), tick(1.1502, t0 + 10_000)],
      5,
    );
    expect(tapeCandleGaps(candles, 5)).toEqual([]);
  });

  it('reports each break with the levels either side and its real duration', () => {
    const candles = aggregateTapeCandles(
      [tick(1.1525, t0), tick(1.1526, t0 + 1000), tick(1.1492, t0 + 10_000_000)],
      5,
    );
    const gaps = tapeCandleGaps(candles, 5);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.fromPrice).toBeCloseTo(1.1526, 6);
    expect(gaps[0]!.toPrice).toBeCloseTo(1.1492, 6);
    expect(gaps[0]!.gapMs).toBeGreaterThan(9_000_000);
  });
});

describe('withFillPrints', () => {
  const tick = (t: number, mid: number) => ({ t, mid, bid: mid - 0.0001, ask: mid + 0.0001 });

  it('puts a fill the series starts after into the tape at its own time', () => {
    // The reported chart: the tape began 13 minutes after the take-profit
    // filled, so the pin sat on a bar that never reached the level.
    const tape = [tick(1_300_000, 1.1418), tick(1_301_000, 1.1419)];
    const out = withFillPrints(tape, [{ t: 520_000, px: 1.14245 }]);
    // One price on every side, so a bid-, ask- or mid-drawn bar contains it.
    expect(out[0]).toMatchObject({ t: 520_000, mid: 1.14245, bid: 1.14245, ask: 1.14245 });
    expect(out.slice(1)).toEqual(tape);
  });

  it('adds the print beside the tick at the fill moment, keeping the recorded one', () => {
    const tape = [tick(1_000, 1.1409), tick(2_000, 1.1410)];
    const out = withFillPrints(tape, [{ t: 2_000, px: 1.14103 }]);
    expect(out.map(p => p.mid)).toEqual([1.1409, 1.1410, 1.14103]);
  });

  it('leaves out a print in another convention', () => {
    const tape = [tick(1_000, 1.1409)];
    // 170 pips away: a forward print on a spot series.
    expect(withFillPrints(tape, [{ t: 1_500, px: 1.1579 }])).toEqual(tape);
  });

  it('ignores invalid fills and an empty tape', () => {
    const tape = [tick(1_000, 1.1409)];
    expect(withFillPrints(tape, [{ t: 0, px: 1.141 }, { t: 1_000, px: Number.NaN }])).toEqual(tape);
    expect(withFillPrints([], [{ t: 1_000, px: 1.141 }])).toEqual([]);
  });
});
