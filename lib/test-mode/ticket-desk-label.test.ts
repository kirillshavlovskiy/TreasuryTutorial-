import { describe, expect, it } from 'vitest';
import {
  signedTradeLocal,
  spotReferencedLegShift,
  placementAnchorRate,
  tapeOrderLevels,
  executionFillRate,
  ticketBlotterLabel,
  ticketFillWorkingLabel,
  ticketRoleLabel,
  ticketTradeSide,
  limitTakeProfitHit,
  ticketLimitLevelLabel,
  ticketGoodTillLabel,
  nextFxDayCloseMs,
  formatGoodTillMs,
} from '@/lib/test-mode/ticket-desk-label';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';

function ticket(partial: Partial<HedgeTicket> = {}): HedgeTicket {
  return {
    id: 'g1',
    ccy: 'GBP',
    instrument: 'forward',
    basis: 'totalBuildup',
    amountLocalM: 5.08,
    orderSide: 'Sell',
    orderHit: 'bid',
    orderType: 'stopLoss',
    bracketRole: 'stopLoss',
    maturity: '1y',
    maturityLabel: '1Y',
    varUsdM: 0,
    addressesHigherVar: true,
    status: 'scheduled',
    limitRate: 1.34,
    ...partial,
  };
}

describe('ticket blotter copy', () => {
  it('buy take-profit is unsigned; sell stop-loss is minus', () => {
    const buy = ticket({
      orderSide: 'Buy',
      amountLocalM: -5.08,
      orderType: 'takeProfit',
      bracketRole: 'takeProfit',
      orderHit: 'bid',
    });
    expect(ticketBlotterLabel(buy)).toBe(
      'TAKE PROFIT · BUY GBP · £5.08M',
    );
    expect(ticketFillWorkingLabel(buy)).toBe(
      '0.00M filled / £5.08M working',
    );

    const sell = ticket();
    expect(ticketTradeSide(sell)).toBe('Sell');
    expect(limitTakeProfitHit('Sell')).toBe('ask');
    expect(ticketRoleLabel(sell)).toBe('STOP LOSS');
    expect(signedTradeLocal('GBP', 5.08, 'Sell')).toBe('−£5.08M');
    expect(ticketBlotterLabel(sell)).toBe(
      'STOP LOSS · SELL GBP · −£5.08M',
    );
    expect(ticketFillWorkingLabel(sell)).toBe(
      '0.00M filled / −£5.08M working',
    );
    // Cancelled is neither filled nor working — the old copy reported the
    // dead order's full notional as still working on the tile. Zeroing the
    // amounts left the WORD "working" on a dead row, which wrapped onto its
    // own line and read as a second status contradicting the CANCELED badge.
    // A dead order names its state rather than counting zeroes.
    expect(
      ticketFillWorkingLabel({ ...sell, status: 'cancelled' }),
    ).toBe('0.00M filled · cancelled');
  });

  it('shows limit level and GTD / GTC', () => {
    const gtc = ticket({ limitRate: 1.34689, orderValidity: 'GTC' });
    expect(ticketLimitLevelLabel(gtc)).toBe('@ 1.34689');
    expect(ticketGoodTillLabel(gtc)).toBe('GTC');

    const dayClose = nextFxDayCloseMs(Date.parse('2026-09-04T08:48:00-04:00'));
    const day = ticket({
      limitRate: 1.34,
      orderValidity: 'DAY',
      goodTillMs: dayClose,
    });
    expect(ticketLimitLevelLabel(day)).toBe('@ 1.34000');
    expect(ticketGoodTillLabel(day)).toBe(`GTD ${formatGoodTillMs(dayClose)}`);
    expect(formatGoodTillMs(dayClose)).toMatch(/4 Sept? 17:00/);
  });

  it('labels a live print as MARKET and shows the fill, not the rest level', () => {
    const fill = ticket({
      orderType: 'market',
      bracketRole: undefined,
      status: 'booked',
      limitRate: 1.1659,
      filledAtMs: 1,
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.17,
        fxOutright: 1.16596,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
      },
    });
    expect(ticketRoleLabel(fill)).toBe('MARKET');
    expect(ticketLimitLevelLabel(fill)).toBe('@ 1.16596');
  });

  it('marks a spot-referenced forward\'s resting level as spot and shows its booked forward', () => {
    const working = ticket({
      orderType: 'takeProfit',
      bracketRole: 'takeProfit',
      isSpotReferenced: true,
      stripLegPoints: 170.1,
      limitRate: 1.1628,
    });
    expect(ticketLimitLevelLabel(working)).toBe('@ 1.16280 spot');
    const booked = ticket({
      ...working,
      status: 'booked',
      filledAtMs: 1,
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.1625,
        fxOutright: 1.17951,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
      },
    });
    expect(ticketLimitLevelLabel(booked)).toBe('@ 1.17951');
  });
});

describe('tapeOrderLevels', () => {
  const rates = { bid: '1.16199', ask: '1.16260' };

  it('labels a placed stop SL, never TP, whichever pad it rests on', () => {
    // The reported defect: a stop-loss was left, the fill marker read
    // "FILL · SL · BID", and the price line at that same level read "TP" in
    // take-profit green. The order's own bracketRole is the authority.
    const levels = tapeOrderLevels({
      placed: [{ limitRate: 1.16199, bracketRole: 'stopLoss' }],
      side: 'Sell',
      previewRates: rates,
    });
    expect(levels).toEqual([{ price: 1.16199, role: 'SL' }]);
  });

  it('does not draw a preview line for an order the desk never placed', () => {
    const levels = tapeOrderLevels({
      placed: [{ limitRate: 1.16199, bracketRole: 'stopLoss' }],
      side: 'Sell',
      previewRates: rates,
    });
    expect(levels.some(l => l.role === 'TP')).toBe(false);
  });

  it('draws preview levels at spot plus the leg points on a forward chart', () => {
    // Typed levels are spot; on an M2 leg's chart (+29 pips) they sit at the
    // forward, like a resting spot-referenced order does. Hand check:
    // 1.16260 + 0.0029 = 1.16550 for the sell take-profit on the ask.
    const levels = tapeOrderLevels({
      placed: [],
      side: 'Sell',
      previewRates: rates,
      chartIsSpot: false,
      previewShift: 0.0029,
    });
    expect(levels.map(l => [l.role, Number(l.price.toFixed(5))])).toEqual([
      ['TP', 1.1655],
      ['SL', 1.16489],
    ]);
    expect(levels.every(l => l.preview === true)).toBe(true);
    // Unshifted on a spot chart, and a blank pad still draws nothing.
    expect(
      tapeOrderLevels({ placed: [], side: 'Sell', previewRates: rates, previewShift: 0 }),
    ).toEqual([
      { price: 1.1626, role: 'TP', preview: true },
      { price: 1.16199, role: 'SL', preview: true },
    ]);
    expect(
      tapeOrderLevels({
        placed: [],
        side: 'Sell',
        previewRates: { bid: '', ask: '' },
        previewShift: 0.0029,
      }),
    ).toEqual([]);
  });

  it('keeps both roles on an OCO pair', () => {
    const levels = tapeOrderLevels({
      placed: [
        { limitRate: 1.1626, bracketRole: 'takeProfit' },
        { limitRate: 1.16199, bracketRole: 'stopLoss' },
      ],
      side: 'Sell',
      previewRates: null,
    });
    expect(levels).toEqual([
      { price: 1.1626, role: 'TP' },
      { price: 1.16199, role: 'SL' },
    ]);
  });

  it('marks a cancelled OCO sibling as cancelled, never filled, alongside a fill', () => {
    // TP filled; SL was auto-cancelled by the OCO but stays in the book with
    // its original limitRate — the chart should still draw its level, tagged
    // so the caller can paint it grey rather than resting SL rose.
    const filledIpaQuote = {
      strike: null,
      strikeInput: '',
      premiumUsd: null,
      premiumPercent: null,
      fxSpot: 1.1626,
      fxOutright: 1.1626,
      atmVolPercent: null,
      impliedVolPercent: null,
      deltaPercent: null,
    };
    const levels = tapeOrderLevels({
      placed: [
        {
          id: 'tp-0',
          limitRate: 1.1626,
          bracketRole: 'takeProfit',
          status: 'booked',
          filledAtMs: 1_700_000_000_500,
          ipaQuote: filledIpaQuote,
        },
        {
          id: 'sl-0',
          limitRate: 1.16199,
          bracketRole: 'stopLoss',
          status: 'cancelled',
        },
      ],
      side: 'Sell',
      previewRates: null,
    });
    expect(levels).toEqual([
      { price: 1.1626, role: 'TP', filled: true },
      { price: 1.16199, role: 'SL', cancelled: true },
    ]);
  });

  it('a plain resting order with no bracket role is LIMIT', () => {
    const levels = tapeOrderLevels({
      placed: [{ limitRate: 1.1626, bracketRole: undefined }],
      side: 'Buy',
      previewRates: null,
    });
    expect(levels).toEqual([{ price: 1.1626, role: 'LIMIT' }]);
  });

  it('still previews the level being composed beside a cancelled sibling', () => {
    // The reported defect: an OCO was being typed with a cancelled stop on
    // the chart, and the take-profit about to be submitted drew no line —
    // the preview bailed as soon as ANY level existed, cancelled included.
    const levels = tapeOrderLevels({
      placed: [
        { limitRate: 1.138, bracketRole: 'stopLoss', status: 'cancelled' },
      ],
      side: 'Sell',
      previewRates: { bid: '1.138', ask: '1.13864' },
    });
    expect(levels).toEqual([
      { price: 1.138, role: 'SL', cancelled: true },
      // The SL preview is the cancelled level's own price — one line, not two.
      { price: 1.13864, role: 'TP', preview: true },
    ]);
  });

  it('draws no preview beside an order that is actually working', () => {
    // previewRates holds a market-derived default until the desk edits it,
    // so a live order must not gain a phantom sibling line.
    const levels = tapeOrderLevels({
      placed: [{ limitRate: 1.16199, bracketRole: 'stopLoss' }],
      side: 'Sell',
      previewRates: { bid: '1.16199', ask: '1.16260' },
    });
    expect(levels).toEqual([{ price: 1.16199, role: 'SL' }]);
  });

  it('previews the TP on the pad the submit buttons use, per side', () => {
    // Sell arms the ask as take-profit, Buy arms the bid. Reading the raw
    // armed pad instead of the side swapped these two labels on a flip.
    expect(limitTakeProfitHit('Sell')).toBe('ask');
    const sell = tapeOrderLevels({ placed: [], side: 'Sell', previewRates: rates });
    expect(sell).toEqual([
      { price: 1.1626, role: 'TP', preview: true },
      { price: 1.16199, role: 'SL', preview: true },
    ]);
    const buy = tapeOrderLevels({ placed: [], side: 'Buy', previewRates: rates });
    expect(buy).toEqual([
      { price: 1.16199, role: 'TP', preview: true },
      { price: 1.1626, role: 'SL', preview: true },
    ]);
  });

  it('draws nothing when there is neither a placed order nor a typed level', () => {
    expect(tapeOrderLevels({ placed: [], side: 'Buy', previewRates: null })).toEqual([]);
    expect(
      tapeOrderLevels({ placed: [], side: 'Buy', previewRates: { bid: '', ask: '' } }),
    ).toEqual([]);
  });

  it('ignores a placed order with no usable level', () => {
    const levels = tapeOrderLevels({
      placed: [
        { limitRate: undefined, bracketRole: 'takeProfit' },
        { limitRate: 1.16199, bracketRole: 'stopLoss' },
      ],
      side: 'Sell',
      previewRates: null,
    });
    expect(levels).toEqual([{ price: 1.16199, role: 'SL' }]);
  });

  const spotRefStop = {
    id: 'sl5',
    ccy: 'EUR',
    limitRate: 1.159,
    bracketRole: 'stopLoss' as const,
    isSpotReferenced: true,
    stripLegPoints: 170.1,
    status: 'booked' as const,
    filledAtMs: 1_700_000_000_000,
    ipaQuote: {
      strike: null,
      strikeInput: '',
      premiumUsd: null,
      premiumPercent: null,
      fxSpot: 1.15933,
      fxOutright: 1.17634,
      atmVolPercent: null,
      impliedVolPercent: null,
      deltaPercent: null,
    },
  };

  const spotRefWorking = {
    ...spotRefStop,
    status: 'scheduled' as const,
    filledAtMs: undefined,
    ipaQuote: undefined,
  };

  it('draws a resting spot-referenced stop at the leg forward', () => {
    // 1.159 spot limit + 170.1 points = 1.17601, and the spot level travels
    // along so the HIT check can still find the order that set it.
    expect(
      tapeOrderLevels({
        placed: [spotRefWorking],
        side: 'Sell',
        previewRates: null,
        chartIsSpot: false,
      }),
    ).toEqual([{ price: 1.17601, role: 'SL', spotLimitRate: 1.159 }]);
  });

  it('keeps a resting spot-referenced stop at spot on the spot record', () => {
    expect(
      tapeOrderLevels({ placed: [spotRefWorking], side: 'Sell', previewRates: null }),
    ).toEqual([{ price: 1.159, role: 'SL' }]);
  });

  it('draws a spot-referenced fill at its booked forward on a leg chart', () => {
    expect(
      tapeOrderLevels({
        placed: [spotRefStop],
        side: 'Sell',
        previewRates: null,
        chartIsSpot: false,
      }),
    ).toEqual([{ price: 1.17634, role: 'SL', filled: true }]);
  });

  it('keeps that same fill at its spot print on the spot record', () => {
    expect(
      tapeOrderLevels({ placed: [spotRefStop], side: 'Sell', previewRates: null }),
    ).toEqual([{ price: 1.15933, role: 'SL', filled: true }]);
  });

  it('ignores the sticky spot print on a leg chart', () => {
    // stickyFills freezes the print the order executed on, which is spot. On
    // the leg chart that print sits a whole points-shift off every candle.
    expect(
      tapeOrderLevels({
        placed: [spotRefStop],
        side: 'Sell',
        previewRates: null,
        stickyFills: { sl5: 1.15933 },
        chartIsSpot: false,
      }),
    ).toEqual([{ price: 1.17634, role: 'SL', filled: true }]);
  });

  it('leaves a cover that traded its own outright alone', () => {
    const cover = {
      id: 'c1',
      ccy: 'EUR',
      limitRate: 1.17,
      bracketRole: undefined,
      status: 'booked' as const,
      filledAtMs: 1_700_000_000_000,
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.16,
        fxOutright: 1.17042,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
      },
    };
    expect(
      tapeOrderLevels({
        placed: [cover],
        side: 'Buy',
        previewRates: null,
        chartIsSpot: false,
      }),
    ).toEqual([{ price: 1.17042, role: 'LIMIT', filled: true }]);
  });

  it('scales leg points to a price distance by pair', () => {
    expect(
      spotReferencedLegShift({ ccy: 'EUR', isSpotReferenced: true, stripLegPoints: 170.1 }),
    ).toBeCloseTo(0.01701, 9);
    expect(
      spotReferencedLegShift({ ccy: 'JPY', isSpotReferenced: true, stripLegPoints: 170.1 }),
    ).toBeCloseTo(1.701, 9);
    expect(
      spotReferencedLegShift({ ccy: 'EUR', isSpotReferenced: false, stripLegPoints: 170.1 }),
    ).toBeNull();
    expect(
      spotReferencedLegShift({ ccy: 'EUR', isSpotReferenced: true, stripLegPoints: 0 }),
    ).toBeNull();
  });

  it('pins a spot-referenced placement at the leg forward, not the spot it rested on', () => {
    // The reported defect: an EUR M2 leg left on the spot tile at 1.1595
    // pinned PLACED at 1.1595 under a series drawn at spot + 28 pips, and
    // the opening candle grew a wick down to it.
    expect(
      placementAnchorRate({
        ccy: 'EUR',
        isSpotReferenced: true,
        stripLegPoints: 28,
        restingAnchorRate: 1.1595,
        limitRate: 1.1601,
      }),
    ).toBeCloseTo(1.1623, 9);
    // Everything else pins where it rested; the limit stands in for a
    // missing anchor; nothing pins with neither.
    expect(
      placementAnchorRate({ ccy: 'EUR', restingAnchorRate: 1.1595, limitRate: 1.1601 }),
    ).toBe(1.1595);
    expect(placementAnchorRate({ ccy: 'EUR', limitRate: 1.1601 })).toBe(1.1601);
    expect(placementAnchorRate({ ccy: 'EUR' })).toBeNull();
  });

  it('locks a filled TP/SL at the execution print, not the resting limit', () => {
    const tp = tapeOrderLevels({
      placed: [
        {
          id: 'tp1',
          limitRate: 1.17,
          bracketRole: 'takeProfit',
          status: 'booked',
          filledAtMs: 1_700_000_000_000,
          ipaQuote: {
            strike: null,
            strikeInput: '',
            premiumUsd: null,
            premiumPercent: null,
            fxSpot: 1.165,
            fxOutright: 1.17042,
            atmVolPercent: null,
            impliedVolPercent: null,
            deltaPercent: null,
          },
        },
      ],
      side: 'Buy',
      previewRates: null,
    });
    expect(tp).toEqual([{ price: 1.17042, role: 'TP', filled: true }]);

    const sl = tapeOrderLevels({
      placed: [
        {
          id: 'sl1',
          limitRate: 1.16,
          bracketRole: 'stopLoss',
          status: 'booked',
          filledAtMs: 1_700_000_000_000,
          ipaQuote: {
            strike: null,
            strikeInput: '',
            premiumUsd: null,
            premiumPercent: null,
            fxSpot: 1.161,
            fxOutright: 1.15980,
            atmVolPercent: null,
            impliedVolPercent: null,
            deltaPercent: null,
          },
        },
      ],
      side: 'Buy',
      previewRates: null,
    });
    expect(sl).toEqual([{ price: 1.15980, role: 'SL', filled: true }]);
  });

  it('stickyFills freeze the rate even if ipaQuote later drifts', () => {
    const levels = tapeOrderLevels({
      placed: [
        {
          id: 'tp1',
          limitRate: 1.17,
          bracketRole: 'takeProfit',
          status: 'booked',
          filledAtMs: 1,
          ipaQuote: {
            strike: null,
            strikeInput: '',
            premiumUsd: null,
            premiumPercent: null,
            fxSpot: 1.18,
            fxOutright: 1.18111,
            atmVolPercent: null,
            impliedVolPercent: null,
            deltaPercent: null,
          },
        },
      ],
      side: 'Buy',
      stickyFills: { tp1: 1.17042 },
      previewRates: null,
    });
    expect(levels).toEqual([{ price: 1.17042, role: 'TP', filled: true }]);
  });
});

describe('executionFillRate', () => {
  it('returns null while resting', () => {
    expect(
      executionFillRate({
        status: 'scheduled',
        filledAtMs: undefined,
        limitRate: 1.17,
        ipaQuote: undefined,
      }),
    ).toBeNull();
  });

  it('prefers the stamped fill print over the resting limit', () => {
    expect(
      executionFillRate({
        status: 'booked',
        filledAtMs: 100,
        limitRate: 1.17,
        ipaQuote: {
          strike: null,
          strikeInput: '',
          premiumUsd: null,
          premiumPercent: null,
          fxSpot: 1.165,
          fxOutright: 1.17042,
          atmVolPercent: null,
          impliedVolPercent: null,
          deltaPercent: null,
        },
      }),
    ).toBe(1.17042);
  });

  it('reads a spot-referenced forward\'s fill on the spot tape it executed on', () => {
    expect(
      executionFillRate({
        status: 'booked',
        filledAtMs: 100,
        limitRate: 1.1628,
        isSpotReferenced: true,
        ipaQuote: {
          strike: null,
          strikeInput: '',
          premiumUsd: null,
          premiumPercent: null,
          fxSpot: 1.1625,
          fxOutright: 1.17951,
          atmVolPercent: null,
          impliedVolPercent: null,
          deltaPercent: null,
        },
      }),
    ).toBe(1.1625);
  });
});

describe('ticketRoleLabel — a market print is never LIMIT', () => {
  // Observed on the live EUR book: a bullet buy-back that had executed
  // (filledAtMs and orderHit set, no limitRate) carried no `status`, because
  // composeDecisionBookTicket creates without one. The old rule required
  // `status === 'booked'` to say MARKET, so this fell through to the
  // catch-all and the blotter read "LIMIT · BUY EUR · €0.02M".
  const base = {
    ccy: 'EUR',
    instrument: 'forward' as const,
    basis: 'totalBuildup' as const,
    amountLocalM: -0.02085915,
    maturity: '1y' as const,
    maturityLabel: '1 year · bullet Tf',
    varUsdM: 0.1,
    addressesHigherVar: true,
  };

  it('calls a filled order with no resting level MARKET, with no status', () => {
    expect(
      ticketRoleLabel({
        ...base,
        id: 'no-status',
        filledAtMs: 1_789_920_855_700,
        orderHit: 'bid',
      }),
    ).toBe('MARKET');
  });

  it('still calls a genuine resting level LIMIT', () => {
    expect(
      ticketRoleLabel({
        ...base,
        id: 'real-limit',
        status: 'scheduled',
        limitRate: 1.164,
      }),
    ).toBe('LIMIT');
  });

  it('keeps a booked market print MARKET', () => {
    expect(
      ticketRoleLabel({
        ...base,
        id: 'booked-mkt',
        status: 'booked',
        filledAtMs: 1_789_920_855_700,
      }),
    ).toBe('MARKET');
  });
});

describe('placementAnchorRate — forward-tile orders', () => {
  // The real leg from the book: a take-profit left on the FORWARD tile keeps
  // its level as the outright and its anchor as the spot mid, one pip from
  // the stamped spot and a 25.3-pip points width from its own outright.
  const fwdTileTp = {
    ccy: 'EUR',
    instrument: 'forward' as const,
    restingAnchorRate: 1.14174,
    limitRate: 1.1441,
    ipaQuote: {
      strike: null,
      strikeInput: '',
      premiumUsd: null,
      premiumPercent: null,
      fxSpot: 1.14164,
      fxOutright: 1.14417,
      atmVolPercent: null,
      impliedVolPercent: null,
      deltaPercent: null,
    },
  };

  it('lifts a spot anchor onto the forward the chart draws', () => {
    // 1.14174 + (1.14417 - 1.14164) = 1.14427 — among the candles, instead of
    // 25 pips below them where widenCandlesToFills stretched a bar to reach it.
    expect(placementAnchorRate(fwdTileTp)).toBeCloseTo(1.14427, 5);
  });

  it('leaves an anchor already stored at the outright alone', () => {
    expect(
      placementAnchorRate({ ...fwdTileTp, restingAnchorRate: 1.14415 }),
    ).toBeCloseTo(1.14415, 5);
  });

  it('keeps a spot ticket untouched', () => {
    expect(
      placementAnchorRate({ ...fwdTileTp, instrument: 'spot' }),
    ).toBeCloseTo(1.14174, 5);
  });

  it('keeps the anchor when the ticket carries no stamps to judge by', () => {
    const { ipaQuote: _drop, ...noStamps } = fwdTileTp;
    expect(placementAnchorRate(noStamps)).toBeCloseTo(1.14174, 5);
  });
});
