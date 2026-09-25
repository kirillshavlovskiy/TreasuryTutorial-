import { describe, expect, it } from 'vitest';
import {
  AUTOMATED_HEDGE_LIMIT_USD_M,
  autoFillAllowedByPolicy,
  bracketLegs,
  bracketRoleFor,
  classifyBracketLevel,
  classifyRestingLevel,
  fcySideFromPairSide,
  signedLocalMForPairSide,
  sellsFcyFromPairSide,
  restingOrderHitSide,
  restingOrderTriggersAt,
  settleMonthsFromHedgeTicket,
  ticketNotionalUsdM,
  usdPerLocalFromQuote,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';

/**
 * A resting ("leave") order is a HedgeTicket with status 'scheduled' carrying
 * the level it waits at. `limitRate` and the quote are both in the MARKET-pair
 * convention (EURUSD here: USD per EUR).
 */
function restingOrder(partial: Partial<HedgeTicket> & Pick<HedgeTicket, 'id'>): HedgeTicket {
  return {
    ccy: 'EUR',
    instrument: 'forward',
    basis: 'totalBuildup',
    amountLocalM: 5,
    maturity: '1y',
    maturityLabel: '1Y',
    varUsdM: 0,
    addressesHigherVar: true,
    status: 'scheduled',
    limitRate: 1.1,
    ...partial,
  };
}

const quote = (bid: number, ask: number) => ({ bid, ask });

describe('restingOrderTriggersAt', () => {
  it('a sell fills once the bid reaches the level', () => {
    const sell = restingOrder({ id: 's', amountLocalM: 5, limitRate: 1.1 });
    expect(restingOrderTriggersAt(sell, quote(1.0999, 1.1005))).toBe(false);
    expect(restingOrderTriggersAt(sell, quote(1.1, 1.1006))).toBe(true);
    expect(restingOrderTriggersAt(sell, quote(1.103, 1.1036))).toBe(true);
  });

  it('a buy fills once the ask falls to the level', () => {
    const buy = restingOrder({ id: 'b', amountLocalM: -5, limitRate: 1.1 });
    expect(restingOrderTriggersAt(buy, quote(1.1005, 1.1001))).toBe(false);
    expect(restingOrderTriggersAt(buy, quote(1.0994, 1.1))).toBe(true);
    expect(restingOrderTriggersAt(buy, quote(1.097, 1.098))).toBe(true);
  });

  it('a sell never fills off the ask, nor a buy off the bid', () => {
    // Guards the side mix-up: a sell lifting the bid must ignore a through-ask.
    const sell = restingOrder({ id: 's', amountLocalM: 5, limitRate: 1.1 });
    expect(restingOrderTriggersAt(sell, quote(1.0998, 1.2))).toBe(false);
    const buy = restingOrder({ id: 'b', amountLocalM: -5, limitRate: 1.1 });
    expect(restingOrderTriggersAt(buy, quote(1.0, 1.1002))).toBe(false);
  });

  it('an already-filled ticket can never re-trigger', () => {
    // This is what stops the monitor double-filling: the level stays on the
    // ticket for the audit trail, so status is the only thing gating it.
    const filled = restingOrder({ id: 'f', status: 'booked', limitRate: 1.1 });
    expect(restingOrderTriggersAt(filled, quote(1.5, 1.5))).toBe(false);
  });

  it('ignores a ticket with no level, and a nonsensical level', () => {
    expect(
      restingOrderTriggersAt(
        restingOrder({ id: 'n', limitRate: undefined }),
        quote(1.5, 1.5),
      ),
    ).toBe(false);
    for (const bad of [0, -1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        restingOrderTriggersAt(restingOrder({ id: 'x', limitRate: bad }), quote(1.5, 1.5)),
      ).toBe(false);
    }
  });

  it('ignores an unusable quote rather than filling at zero', () => {
    const sell = restingOrder({ id: 's', amountLocalM: 5, limitRate: 1.1 });
    expect(restingOrderTriggersAt(sell, quote(0, 0))).toBe(false);
    expect(restingOrderTriggersAt(sell, quote(Number.NaN, Number.NaN))).toBe(false);
  });

  // A ticket left through the Trade Ticket UI always carries `orderHit`
  // (placeLeaveOrder / submitLimitOrder both set it) — the fixtures above
  // never set it, so this is the path every real resting order actually
  // takes, not just the legacy fallback. It must agree with the fallback,
  // not invert it.
  it('a plain resting order with orderHit set behaves exactly like the legacy fallback', () => {
    const sell = restingOrder({
      id: 's-hit',
      amountLocalM: 5,
      orderHit: 'bid',
      orderSide: 'Sell',
      limitRate: 1.1,
    });
    expect(restingOrderTriggersAt(sell, quote(1.0999, 1.1005))).toBe(false);
    expect(restingOrderTriggersAt(sell, quote(1.1, 1.1006))).toBe(true);

    const buy = restingOrder({
      id: 'b-hit',
      amountLocalM: -5,
      orderHit: 'ask',
      orderSide: 'Buy',
      limitRate: 1.1,
    });
    expect(restingOrderTriggersAt(buy, quote(1.1005, 1.1001))).toBe(false);
    expect(restingOrderTriggersAt(buy, quote(1.0994, 1.1))).toBe(true);
  });

  it('a bracket take-profit and stop-loss never fire at the same price, and each fires only at its own level', () => {
    const ocoGroupId = 'g1';
    const takeProfit = restingOrder({
      id: 'tp',
      amountLocalM: 5,
      orderSide: 'Sell',
      orderHit: 'bid',
      bracketRole: 'takeProfit',
      ocoGroupId,
      limitRate: 1.12,
    });
    const stopLoss = restingOrder({
      id: 'sl',
      amountLocalM: 5,
      orderSide: 'Sell',
      orderHit: 'ask',
      bracketRole: 'stopLoss',
      ocoGroupId,
      limitRate: 1.08,
    });

    // Market still between both levels — neither leg has anything to do.
    expect(restingOrderTriggersAt(takeProfit, quote(1.0994, 1.0996))).toBe(false);
    expect(restingOrderTriggersAt(stopLoss, quote(1.0994, 1.0996))).toBe(false);

    // Market reaches the stop level (adverse move) — only the stop fires.
    expect(restingOrderTriggersAt(takeProfit, quote(1.0798, 1.08))).toBe(false);
    expect(restingOrderTriggersAt(stopLoss, quote(1.0798, 1.08))).toBe(true);

    // Market reaches the take-profit level (favorable move) — only the TP
    // fires. A sell take-profit is a passive resting order and fills on the
    // ASK (the opposite side from its own stop-loss sibling, which fires as
    // a market order on the bid — 2026-09-08 desk instruction).
    expect(restingOrderTriggersAt(takeProfit, quote(1.1198, 1.12))).toBe(false);
    expect(restingOrderTriggersAt(takeProfit, quote(1.1199, 1.1201))).toBe(true);
    expect(restingOrderTriggersAt(stopLoss, quote(1.1199, 1.1201))).toBe(false);
  });

  it('distance no longer vetoes the trigger rule (40-pip cap removed)', () => {
    const sl = restingOrder({
      id: 'eur-sl',
      amountLocalM: 2.55,
      orderSide: 'Sell',
      orderHit: 'bid',
      bracketRole: 'stopLoss',
      limitRate: 1.169,
      restingAnchorRate: 1.16936,
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.15231,
        fxOutright: 1.16936,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
      },
    });
    // Product decision 2026-09-08: TAPE_MAX_JUMP_PIPS no longer gates
    // orders — a level any distance from the print evaluates purely on the
    // trigger rule, so a sell stop already through the quote fires instead
    // of resting dead forever. Keeping foreign-convention prints away from
    // a ticket is the tape/key layer's job (tapeQuoteKey lookup + the
    // runtime's feed gates), not the trigger rule's.
    expect(restingOrderTriggersAt(sl, quote(1.1525, 1.1527))).toBe(true);
    expect(restingOrderTriggersAt(sl, quote(1.1689, 1.1691))).toBe(true);
  });
});

describe('classifyBracketLevel — TP better than LIVE REF, SL worse', () => {
  // Screenshot: BUY GBP, bid TP 1.34600 vs LIVE REF 1.34667, ask SL 1.3460
  // vs LIVE REF 1.34679. A buy stop below the ask is already through.
  const gbp = quote(1.34667, 1.34679);

  it('a buy take-profit on the bid rests below the bid', () => {
    const tp = restingOrder({
      id: 'tp',
      ccy: 'GBP',
      amountLocalM: -5,
      orderSide: 'Buy',
      orderHit: 'bid',
      bracketRole: 'takeProfit',
      limitRate: 1.346,
    });
    expect(classifyBracketLevel(tp, gbp)).toBe('rests');
  });

  it('a buy stop-loss on the ask cannot sit below the ask', () => {
    const sl = restingOrder({
      id: 'sl',
      ccy: 'GBP',
      amountLocalM: -5,
      orderSide: 'Buy',
      orderHit: 'ask',
      bracketRole: 'stopLoss',
      limitRate: 1.346,
    });
    expect(classifyBracketLevel(sl, gbp)).toBe('triggered');
  });

  it('a buy stop-loss on the ask rests above the ask', () => {
    const sl = restingOrder({
      id: 'sl',
      ccy: 'GBP',
      amountLocalM: -5,
      orderSide: 'Buy',
      orderHit: 'ask',
      bracketRole: 'stopLoss',
      limitRate: 1.347,
    });
    expect(classifyBracketLevel(sl, gbp)).toBe('rests');
  });

  it('a sell take-profit on the ask cannot sit below the ask', () => {
    const tp = restingOrder({
      id: 'tp',
      ccy: 'GBP',
      amountLocalM: 5,
      orderSide: 'Sell',
      orderHit: 'ask',
      bracketRole: 'takeProfit',
      limitRate: 1.3465,
    });
    expect(classifyBracketLevel(tp, gbp)).toBe('triggered');
  });

  it('a sell stop-loss on the bid rests below the bid', () => {
    const sl = restingOrder({
      id: 'sl',
      ccy: 'GBP',
      amountLocalM: 5,
      orderSide: 'Sell',
      orderHit: 'bid',
      bracketRole: 'stopLoss',
      limitRate: 1.346,
    });
    expect(classifyBracketLevel(sl, gbp)).toBe('rests');
  });

  it('a 1-pip better take-profit is a rest', () => {
    const tp = restingOrder({
      id: 'tp',
      ccy: 'GBP',
      amountLocalM: 5,
      orderSide: 'Sell',
      orderHit: 'ask',
      bracketRole: 'takeProfit',
      limitRate: 1.34689,
    });
    expect(classifyBracketLevel(tp, gbp)).toBe('rests');
  });

  it('a sell-EUR TP above spot rests even when it sits below a 1Y outright', () => {
    // Pad LIVE REF is spot (~1.147). The 1Y FWD outright (~1.163) is the
    // booked contract, not the tape the TP watches. 1.1620 is better than
    // spot for a sell and must rest; vs the outright it looks through.
    const tp = restingOrder({
      id: 'eur-tp-spot',
      ccy: 'EUR',
      amountLocalM: signedLocalMForPairSide('Sell', 10.08, 'EUR', 'EUR'),
      orderSide: 'Sell',
      orderHit: 'ask',
      bracketRole: 'takeProfit',
      limitRate: 1.162,
    });
    expect(classifyBracketLevel(tp, quote(1.1469, 1.147))).toBe('rests');
    expect(classifyBracketLevel(tp, quote(1.1629, 1.1631))).toBe('triggered');
  });
});

describe('pair-base Buy/Sell vs FCY sign — USDMXN / USDPLN', () => {
  it('Sell USD on USDMXN is a MXN buy (negative local)', () => {
    expect(sellsFcyFromPairSide('Sell', 'MXN', 'USD')).toBe(false);
    expect(fcySideFromPairSide('Sell', 'MXN', 'USD')).toBe('Buy');
    expect(signedLocalMForPairSide('Sell', 146.61, 'MXN', 'USD')).toBeCloseTo(-146.61, 9);
  });

  it('Buy USD on USDMXN is a MXN sell', () => {
    expect(sellsFcyFromPairSide('Buy', 'MXN', 'USD')).toBe(true);
    expect(signedLocalMForPairSide('Buy', 146.61, 'MXN', 'USD')).toBeCloseTo(146.61, 9);
  });

  it('EURUSD is not inverted — Sell EUR sells FCY', () => {
    expect(sellsFcyFromPairSide('Sell', 'EUR', 'EUR')).toBe(true);
    expect(signedLocalMForPairSide('Sell', 5, 'EUR', 'EUR')).toBeCloseTo(5, 9);
    expect(signedLocalMForPairSide('Buy', 5, 'EUR', 'EUR')).toBeCloseTo(-5, 9);
  });

  // Screenshot: SELL USD, LIVE REF 17.03542, TP 17.05 above, SL 17.0 below.
  const mxn = quote(17.03541, 17.03542);

  it('a sell-USD take-profit rests above the ask', () => {
    const tp = restingOrder({
      id: 'mxn-tp',
      ccy: 'MXN',
      amountLocalM: signedLocalMForPairSide('Sell', 146.61, 'MXN', 'USD'),
      orderSide: fcySideFromPairSide('Sell', 'MXN', 'USD'),
      orderHit: 'ask',
      bracketRole: 'takeProfit',
      limitRate: 17.05,
    });
    expect(classifyBracketLevel(tp, mxn)).toBe('rests');
  });

  it('a sell-USD stop-loss rests below the bid', () => {
    const sl = restingOrder({
      id: 'mxn-sl',
      ccy: 'MXN',
      amountLocalM: signedLocalMForPairSide('Sell', 146.61, 'MXN', 'USD'),
      orderSide: fcySideFromPairSide('Sell', 'MXN', 'USD'),
      orderHit: 'bid',
      bracketRole: 'stopLoss',
      limitRate: 17.0,
    });
    expect(classifyBracketLevel(sl, mxn)).toBe('rests');
  });

  it('the inverted FCY sign (treat Sell USD as sell MXN) wrongly rejects that TP', () => {
    const tp = restingOrder({
      id: 'mxn-wrong',
      ccy: 'MXN',
      amountLocalM: 146.61,
      orderSide: 'Sell',
      orderHit: 'ask',
      bracketRole: 'takeProfit',
      limitRate: 17.05,
    });
    expect(classifyBracketLevel(tp, mxn)).toBe('triggered');
  });

  it('a buy-USD take-profit rests below the bid', () => {
    const tp = restingOrder({
      id: 'mxn-buy-tp',
      ccy: 'MXN',
      amountLocalM: signedLocalMForPairSide('Buy', 146.61, 'MXN', 'USD'),
      orderSide: fcySideFromPairSide('Buy', 'MXN', 'USD'),
      orderHit: 'bid',
      bracketRole: 'takeProfit',
      limitRate: 17.03,
    });
    expect(classifyBracketLevel(tp, mxn)).toBe('rests');
  });

  it('a buy-USD stop-loss rests above the ask', () => {
    const sl = restingOrder({
      id: 'mxn-buy-sl',
      ccy: 'MXN',
      amountLocalM: signedLocalMForPairSide('Buy', 146.61, 'MXN', 'USD'),
      orderSide: fcySideFromPairSide('Buy', 'MXN', 'USD'),
      orderHit: 'ask',
      bracketRole: 'stopLoss',
      limitRate: 17.04,
    });
    expect(classifyBracketLevel(sl, mxn)).toBe('rests');
  });
});

describe('classifyRestingLevel', () => {
  const live = quote(1.1, 1.1002);

  it('a sell 1 pip above the bid rests', () => {
    const sell = restingOrder({ id: 's', amountLocalM: 5, limitRate: 1.1001 });
    expect(classifyRestingLevel(sell, live)).toBe('rests');
  });

  it('a sell at the bid is already marketable', () => {
    const sell = restingOrder({ id: 's', amountLocalM: 5, limitRate: 1.1 });
    expect(classifyRestingLevel(sell, live)).toBe('triggered');
  });
});

describe('ticketNotionalUsdM', () => {
  it('converts local notional at the caller-supplied spot, unsigned', () => {
    // EUR pinned at 1.0 USD per EUR: 5M EUR -> $5M either direction.
    expect(ticketNotionalUsdM(restingOrder({ id: 'a', amountLocalM: 5 }), 1.0)).toBeCloseTo(5, 9);
    expect(ticketNotionalUsdM(restingOrder({ id: 'b', amountLocalM: -5 }), 1.0)).toBeCloseTo(5, 9);
  });

  it('is zero for an unusable spot rather than guessing one', () => {
    expect(ticketNotionalUsdM(restingOrder({ id: 'a' }), 0)).toBe(0);
    expect(ticketNotionalUsdM(restingOrder({ id: 'b' }), Number.NaN)).toBe(0);
  });

  it('prices a non-unit spot — GBP at 1.26', () => {
    // 8M GBP x 1.26 = $10.08M, hand-checked.
    expect(
      ticketNotionalUsdM(restingOrder({ id: 'g', ccy: 'GBP', amountLocalM: 8 }), 1.26),
    ).toBeCloseTo(10.08, 9);
  });
});

describe('quote convention — USD-base pairs invert both side and direction', () => {
  // EURUSD is USD per EUR (FCY is base). USDPLN is PLN per USD (USD is base).
  // decisions.md "USDPLN CIP — invert points" is this exact class of bug.
  it('a EUR sell lifts the bid and improves as the rate RISES', () => {
    const sell = restingOrder({ id: 'e', ccy: 'EUR', amountLocalM: 5, limitRate: 1.1 });
    expect(restingOrderTriggersAt(sell, quote(1.1, 1.1006))).toBe(true);
    expect(restingOrderTriggersAt(sell, quote(1.0999, 1.2))).toBe(false);
  });

  it('a PLN sell pays the ASK and improves as USDPLN FALLS', () => {
    // Selling PLN buys the base USD, so it lifts the offer, and fewer PLN per
    // USD is better. The pre-fix code read the bid and required rate >= limit,
    // which fired instantly at a worse rate than asked.
    const sell = restingOrder({ id: 'p', ccy: 'PLN', amountLocalM: 20, limitRate: 3.6 });
    expect(restingOrderTriggersAt(sell, quote(3.6399, 3.6405))).toBe(false);
    expect(restingOrderTriggersAt(sell, quote(3.5994, 3.6))).toBe(true);
  });

  it('a PLN buy lifts the BID and improves as USDPLN RISES', () => {
    const buy = restingOrder({ id: 'pb', ccy: 'PLN', amountLocalM: -20, limitRate: 3.7 });
    expect(restingOrderTriggersAt(buy, quote(3.6999, 3.7005))).toBe(false);
    expect(restingOrderTriggersAt(buy, quote(3.7, 3.7006))).toBe(true);
  });

  it('fills a scheduled strip order the same way as a bullet', () => {
    const leg = restingOrder({ id: 'l', stripId: 's1', stripEdgeIndex: 0, limitRate: 1.1 });
    expect(restingOrderTriggersAt(leg, quote(1.1, 1.1006))).toBe(true);
  });

  it('still ignores a market-booked strip leg — it is not a rest', () => {
    const booked = restingOrder({
      id: 'b',
      status: 'booked',
      stripId: 's1',
      stripEdgeIndex: 0,
      limitRate: 1.1,
    });
    expect(restingOrderTriggersAt(booked, quote(1.5, 1.5))).toBe(false);
  });
});

describe('restingOrderHitSide', () => {
  it('an EUR sell works the bid, an EUR buy the ask', () => {
    expect(restingOrderHitSide(restingOrder({ id: 'a', ccy: 'EUR', amountLocalM: 5 }))).toBe('bid');
    expect(restingOrderHitSide(restingOrder({ id: 'b', ccy: 'EUR', amountLocalM: -5 }))).toBe('ask');
  });

  it('inverts for a USD-base pair — a PLN sell works the ask', () => {
    expect(restingOrderHitSide(restingOrder({ id: 'c', ccy: 'PLN', amountLocalM: 20 }))).toBe('ask');
    expect(restingOrderHitSide(restingOrder({ id: 'd', ccy: 'PLN', amountLocalM: -20 }))).toBe('bid');
  });

  it('agrees with the trigger rule about which side it reads', () => {
    // The two must never drift: whichever side hitSide names is the side
    // triggersAt compares against. The untouched side is kept a realistic
    // pip or two away, not a fabricated extreme — a wide fake spread reads
    // as a spot-vs-outright convention break to quoteIsWrongTapeForOrder
    // and would mask the very drift this test exists to catch.
    for (const ccy of ['EUR', 'PLN']) {
      for (const amt of [5, -5]) {
        const t = restingOrder({ id: 'x', ccy, amountLocalM: amt, limitRate: 2 });
        const side = restingOrderHitSide(t);
        const touches =
          side === 'bid' ? { bid: 2, ask: 2.0002 } : { bid: 1.9998, ask: 2 };
        expect(restingOrderTriggersAt(t, touches)).toBe(true);
      }
    }
  });
});

describe('usdPerLocalFromQuote', () => {
  it('passes a USD-per-FCY quote straight through', () => {
    expect(usdPerLocalFromQuote('EUR', 1.1701)).toBeCloseTo(1.1701, 9);
  });

  it('inverts an FCY-per-USD quote — 3.64 USDPLN is $0.2747 per PLN', () => {
    // 1 / 3.64 = 0.274725..., hand-checked.
    expect(usdPerLocalFromQuote('PLN', 3.64)).toBeCloseTo(0.2747252747, 9);
  });

  it('is zero for an unusable quote rather than dividing by zero', () => {
    expect(usdPerLocalFromQuote('PLN', 0)).toBe(0);
    expect(usdPerLocalFromQuote('EUR', Number.NaN)).toBe(0);
  });
});

describe('autoFillAllowedByPolicy', () => {
  it('allows an automated fill at or under the $10M cap', () => {
    expect(AUTOMATED_HEDGE_LIMIT_USD_M).toBe(10);
    expect(autoFillAllowedByPolicy(restingOrder({ id: 'a', amountLocalM: 9.9 }), 1.0)).toBe(true);
    expect(autoFillAllowedByPolicy(restingOrder({ id: 'b', amountLocalM: 10 }), 1.0)).toBe(true);
  });

  it('blocks an automated fill above the cap — it needs FX Lead + CFO', () => {
    expect(autoFillAllowedByPolicy(restingOrder({ id: 'c', amountLocalM: 10.01 }), 1.0)).toBe(false);
    expect(autoFillAllowedByPolicy(restingOrder({ id: 'd', amountLocalM: 500 }), 1.0)).toBe(false);
  });

  it('applies the cap on USD equivalent, not local units', () => {
    // 8M GBP is $10.08M at 1.26 — over the cap despite 8 < 10.
    const gbp = restingOrder({ id: 'g', ccy: 'GBP', amountLocalM: 8 });
    expect(autoFillAllowedByPolicy(gbp, 1.26)).toBe(false);
    expect(autoFillAllowedByPolicy(gbp, 1.0)).toBe(true);
  });

  it('blocks a short above the cap too — the cap is on size, not direction', () => {
    expect(autoFillAllowedByPolicy(restingOrder({ id: 'e', amountLocalM: -25 }), 1.0)).toBe(false);
  });

  it('cannot be split: three 9M orders cannot each pass under a 10M cap', () => {
    // The cap is on the position. Seeded with what is already committed, the
    // second order must be refused rather than each passing 9 <= 10.
    const nine = restingOrder({ id: 'n1', amountLocalM: 9 });
    expect(autoFillAllowedByPolicy(nine, 1.0, 0)).toBe(true);
    expect(autoFillAllowedByPolicy(nine, 1.0, 9)).toBe(false);
    expect(autoFillAllowedByPolicy(nine, 1.0, 1.5)).toBe(false);
  });

  it('counts live cover already on the book toward the cap', () => {
    const two = restingOrder({ id: 't', amountLocalM: 2 });
    expect(autoFillAllowedByPolicy(two, 1.0, 8)).toBe(true);
    expect(autoFillAllowedByPolicy(two, 1.0, 8.01)).toBe(false);
  });

  it('measures the cap at the executing rate, not a scoring pin', () => {
    // 9M EUR is $9M at the curriculum pin of 1.0 but $10.53M at a real 1.1701
    // market rate — allowed under the pin, refused at the rate it fills at.
    const nine = restingOrder({ id: 'r', amountLocalM: 9 });
    expect(autoFillAllowedByPolicy(nine, 1.0)).toBe(true);
    expect(autoFillAllowedByPolicy(nine, usdPerLocalFromQuote('EUR', 1.1701))).toBe(false);
  });

  it('refuses a zero-notional order outright', () => {
    expect(autoFillAllowedByPolicy(restingOrder({ id: 'z', amountLocalM: 0 }), 1.0)).toBe(false);
  });

  it('never auto-fills an option — those need FX Lead at any notional', () => {
    const opt = restingOrder({ id: 'o', instrument: 'option', amountLocalM: 1 });
    expect(autoFillAllowedByPolicy(opt, 1.0)).toBe(false);
  });
});


describe('bracketRoleFor — which leg is take profit', () => {
  // Selling at the bid profits as the rate FALLS, so the lower level is the
  // target and the higher one is the stop. Buying at the ask is the reverse.
  it('bid: lower is take profit, higher is stop loss', () => {
    expect(bracketRoleFor('bid', 1.15, 1.18)).toBe('takeProfit');
    expect(bracketRoleFor('bid', 1.18, 1.15)).toBe('stopLoss');
  });

  it('ask: higher is take profit, lower is stop loss', () => {
    expect(bracketRoleFor('ask', 1.18, 1.15)).toBe('takeProfit');
    expect(bracketRoleFor('ask', 1.15, 1.18)).toBe('stopLoss');
  });

  it('the two sides are exact opposites at the same levels', () => {
    for (const [a, b] of [[1.15, 1.18], [1.18, 1.15], [140, 152.5]]) {
      expect(bracketRoleFor('bid', a!, b!)).not.toBe(bracketRoleFor('ask', a!, b!));
    }
  });

  it('equal levels are not a bracket', () => {
    expect(bracketRoleFor('bid', 1.16, 1.16)).toBeNull();
    expect(bracketRoleFor('ask', 1.16, 1.16)).toBeNull();
  });

  it('rejects an unusable level rather than guessing a role', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(bracketRoleFor('bid', bad, 1.16)).toBeNull();
      expect(bracketRoleFor('bid', 1.16, bad)).toBeNull();
    }
  });
});

describe('bracketLegs', () => {
  it('names both legs for a bid bracket', () => {
    expect(bracketLegs('bid', 1.18, 1.15)).toEqual({ takeProfit: 1.15, stopLoss: 1.18 });
    expect(bracketLegs('bid', 1.15, 1.18)).toEqual({ takeProfit: 1.15, stopLoss: 1.18 });
  });

  it('names both legs for an ask bracket', () => {
    expect(bracketLegs('ask', 1.15, 1.18)).toEqual({ takeProfit: 1.18, stopLoss: 1.15 });
    expect(bracketLegs('ask', 1.18, 1.15)).toEqual({ takeProfit: 1.18, stopLoss: 1.15 });
  });

  it('is order-independent — the pair decides, not which box was typed first', () => {
    for (const side of ['bid', 'ask'] as const) {
      expect(bracketLegs(side, 1.15, 1.18)).toEqual(bracketLegs(side, 1.18, 1.15));
    }
  });

  it('returns null when the pair cannot form a bracket', () => {
    expect(bracketLegs('bid', 1.16, 1.16)).toBeNull();
    expect(bracketLegs('ask', 0, 1.16)).toBeNull();
  });
});

describe('settleMonthsFromHedgeTicket — the leg tenor, not its bucket', () => {
  it('reads maturityMonths before falling back to the tenor bucket', () => {
    // Live defect: a 6-leg EUR strip booked edges at 2/5/7/10/12/10 months,
    // all labelled by bucket ('3m','6m','9m','1y','1y','1y'). Falling
    // straight to horizonMonths(maturity) reported the last three as M12,
    // so the ladder read L4/L5/L6 = M12 and anything grouping by settle
    // month folded three distinct legs into one.
    const leg = (maturityMonths: number, maturity: string) =>
      settleMonthsFromHedgeTicket(
        restingOrder({
          id: `eur-${maturityMonths}`,
          instrument: 'forward',
          maturity,
          maturityMonths,
        } as never),
      );
    expect(leg(10, '1y')).toBe(10);
    expect(leg(12, '1y')).toBe(12);
    expect(leg(7, '9m')).toBe(7);
    // No months on the ticket — the bucket is still the fallback.
    expect(
      settleMonthsFromHedgeTicket(
        restingOrder({ id: 'eur-bucket', instrument: 'forward', maturity: '1y' } as never),
      ),
    ).toBe(12);
  });
});
