import { describe, expect, it } from 'vitest';
import {
  beatEvent,
  blotterLifecycleEvent,
  dedupeMonitorEvents,
  eventsForBeat,
  eventsForTicketModal,
  explainRestingOrder,
  explainWorkingOrders,
  ticketLegExecLog,
  liveCommittedUsdMByCcy,
  monitorEventRichness,
  monitorSnapshotKey,
  nodeBeatStatusLine,
} from '@/lib/test-mode/execution-monitor';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import { tapeQuoteKey } from '@/lib/test-mode/tape-candles';

function ticket(partial: Partial<HedgeTicket> & Pick<HedgeTicket, 'id'>): HedgeTicket {
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

const quote = { bid: 1.099, ask: 1.0996, mid: 1.0993 };

describe('explainRestingOrder', () => {
  it('records WORKING with basis, hit side and distance when the level is not in', () => {
    const d = explainRestingOrder(ticket({ id: 'w' }), quote, 0, 1);
    expect(d.outcome).toBe('working');
    expect(d.basis).toBe('totalBuildup');
    expect(d.hitSide).toBe('bid');
    expect(d.quoteConvention).toBe('usd-per-fcy');
    expect(d.reason).toMatch(/WORKING Sell EUR/);
    expect(d.reason).toMatch(/on totalBuildup/);
    expect(d.distancePips).toBeGreaterThan(0);
  });

  /**
   * `distancePips` is signed by whether the order has triggered, never by the
   * quote side it samples. A stop-loss samples the same side as a plain order
   * but triggers the opposite way, and since the 2026-09-08 desk instruction a
   * take-profit samples the OPPOSITE side while still triggering the same way
   * — so the old `hitSide === 'bid'` sign reported a working take-profit as
   * already through. Prices below are the real recorded EUR|spot bracket:
   * limit 1.16310, working tick bid 1.16289770 / ask 1.16309770, crossing tick
   * bid 1.16291764 / ask 1.16311764.
   */
  const spotTape = { limitRate: 1.1631, instrument: 'spot' as const };
  const tapeWorking = { bid: 1.1628977, ask: 1.1630977, mid: 1.1629977 };
  const tapeCrossed = { bid: 1.16291764, ask: 1.16311764, mid: 1.16301764 };

  it('reports a working take-profit as still away from the market, not through it', () => {
    const d = explainRestingOrder(
      ticket({ id: 'tp-w', bracketRole: 'takeProfit', ...spotTape }),
      tapeWorking,
      0,
      1,
    );
    // Sell take-profit fills on the ask under the 2026-09-08 convention.
    expect(d.hitSide).toBe('ask');
    expect(d.outcome).toBe('working');
    expect(d.distancePips).toBeGreaterThan(0);
    expect(d.distancePips).toBeCloseTo(0.023, 3);
  });

  it('reports a filled take-profit as through the level', () => {
    const d = explainRestingOrder(
      ticket({ id: 'tp-f', bracketRole: 'takeProfit', ...spotTape }),
      tapeCrossed,
      0,
      1,
    );
    expect(d.outcome).toBe('filled');
    expect(d.distancePips).toBeLessThan(0);
    expect(d.distancePips).toBeCloseTo(-0.1764, 3);
  });

  it('reports a triggered stop-loss as through the level, like every other filled order', () => {
    const d = explainRestingOrder(
      ticket({ id: 'sl-f', bracketRole: 'stopLoss', ...spotTape }),
      tapeWorking,
      0,
      1,
    );
    // A sell stop still fires on the bid — the take-profit flip did not move it.
    expect(d.hitSide).toBe('bid');
    expect(d.outcome).toBe('filled');
    expect(d.distancePips).toBeLessThan(0);
    expect(d.distancePips).toBeCloseTo(-2.023, 3);
  });

  it('records FILLED on the executing side and basis when the bid reaches the sell limit', () => {
    const d = explainRestingOrder(
      ticket({ id: 'f' }),
      { bid: 1.1, ask: 1.1006, mid: 1.1003 },
      0,
      1,
    );
    expect(d.outcome).toBe('filled');
    expect(d.filledPx).toBe(1.1);
    expect(d.hitSide).toBe('bid');
    expect(d.basis).toBe('totalBuildup');
    expect(d.reason).toMatch(/FILLED/);
    expect(d.reason).toMatch(/on totalBuildup/);
    expect(d.autoFillAllowed).toBe(true);
  });

  it('records BLOCKED with the policy cap when notional is over the auto limit', () => {
    const d = explainRestingOrder(
      ticket({ id: 'b', amountLocalM: 20, basis: 'stock' }),
      { bid: 1.1, ask: 1.1006, mid: 1.1 },
      0,
      1,
    );
    expect(d.outcome).toBe('blocked-policy');
    expect(d.basis).toBe('stock');
    expect(d.autoFillAllowed).toBe(false);
    expect(d.reason).toMatch(/BLOCKED/);
    expect(d.reason).toMatch(/on stock/);
    expect(d.reason).toMatch(/FX Lead/);
  });

  it('skips already-booked tickets so the monitor cannot double-fill', () => {
    const d = explainRestingOrder(
      ticket({ id: 'x', status: 'booked' }),
      { bid: 1.5, ask: 1.5, mid: 1.5 },
      0,
    );
    expect(d.outcome).toBe('skipped');
    expect(d.skipReason).toBe('not-scheduled');
  });
});

describe('eventsForBeat', () => {
  it('emits a working row once, then nothing while the book is unchanged', () => {
    const working = explainRestingOrder(ticket({ id: 'w' }), quote, 0, 10);
    const first = eventsForBeat([working], 2, 1, true, 10, '');
    expect(first.some(e => e.kind === 'order' && e.outcome === 'working')).toBe(
      true,
    );
    expect(first.some(e => e.kind === 'beat')).toBe(false);
    const key = monitorSnapshotKey([working]);
    expect(eventsForBeat([working], 2, 1, true, 11, key)).toHaveLength(0);
  });

  it('emits a fill once and does not repeat it on the next identical beat', () => {
    const working = explainRestingOrder(ticket({ id: 'w' }), quote, 0, 10);
    const filled = explainRestingOrder(
      ticket({ id: 'f' }),
      { bid: 1.1, ask: 1.1006, mid: 1.1003 },
      0,
      10,
    );
    const fillBeat = eventsForBeat([working, filled], 3.5, 1, false, 10);
    expect(fillBeat[0]).toMatchObject({
      kind: 'beat',
      filled: 1,
      working: 1,
      elapsedMs: 3.5,
    });
    expect(fillBeat.some(e => e.kind === 'order' && e.outcome === 'filled')).toBe(
      true,
    );
    const key = monitorSnapshotKey([working, filled]);
    expect(eventsForBeat([working, filled], 3.5, 1, true, 11, key)).toHaveLength(
      0,
    );
  });

  it('dedupes repeated fills and idle beats newest-first', () => {
    const filled = explainRestingOrder(
      ticket({ id: 'f' }),
      { bid: 1.1, ask: 1.1006, mid: 1.1003 },
      0,
      20,
    );
    const ev = eventsForBeat([filled], 1, 1, false, 20);
    const fill = ev.find(e => e.kind === 'order' && e.outcome === 'filled')!;
    const idleBeat = beatEvent([], 1, 7, 21);
    const laterFill = { ...fill, atMs: 30 };
    const rows = dedupeMonitorEvents([laterFill, idleBeat, fill]);
    expect(rows.filter(e => e.kind === 'order')).toHaveLength(1);
    expect(rows.some(e => e.kind === 'beat' && e.triggered === 0)).toBe(false);
  });

  it('keeps the matcher FILLED line instead of a thin blotter booked stub', () => {
    const filled = explainRestingOrder(
      ticket({ id: 'f' }),
      { bid: 1.1, ask: 1.1006, mid: 1.1003 },
      0,
      20,
    );
    const rich = eventsForBeat([filled], 1, 1, false, 20).find(
      e => e.kind === 'order' && e.outcome === 'filled',
    )!;
    const thin = blotterLifecycleEvent(
      ticket({
        id: 'f',
        status: 'booked',
        ipaQuote: {
          strike: null,
          strikeInput: '',
          premiumUsd: null,
          premiumPercent: null,
          fxSpot: 1.1,
          fxOutright: 1.1,
          atmVolPercent: null,
          impliedVolPercent: null,
          deltaPercent: null,
        },
      }),
      'filled',
      30,
    );
    const thinStub = {
      ...thin,
      summary: 'Sell EUR take profit booked',
      reason: 'Sell EUR take profit booked',
      notionalUsdM: 0,
      marketBid: null,
      marketAsk: null,
    };
    expect(monitorEventRichness(rich)).toBeGreaterThan(monitorEventRichness(thinStub));
    const rows = dedupeMonitorEvents([thinStub, rich]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toMatch(/FILLED/);
    expect(rows[0]?.summary).toMatch(/crossed limit/);
  });

  it('drops legacy "take profit booked" stubs so they cannot freeze the monitor', () => {
    const stub = blotterLifecycleEvent(
      ticket({
        id: 'gbp-tp',
        status: 'booked',
        ccy: 'GBP',
        bracketRole: 'takeProfit',
      }),
      'filled',
    );
    const frozen = {
      ...stub,
      summary: 'Sell GBP take profit booked',
      reason: 'Sell GBP take profit booked',
      notionalUsdM: 0,
    };
    expect(dedupeMonitorEvents([frozen, frozen])).toHaveLength(0);
  });

  it('beat summary includes timing', () => {
    expect(beatEvent([], 12.25, 2, 1).summary).toBe(
      'BEAT 12.3ms · 2 CCY · 0 working · 0 triggered (0 fill / 0 blocked)',
    );
    expect(
      nodeBeatStatusLine({
        elapsedMs: 0,
        ccyCount: 7,
        working: 1,
        filled: 1,
        blocked: 0,
      }),
    ).toBe(
      '[node] BEAT 0.0ms · 7 CCY · 1 working · 1 triggered (1 fill / 0 blocked)',
    );
  });
});

describe('blotterLifecycleEvent', () => {
  it('records size, limit, tape diagnosis, notional and cap — not a one-line booked stub', () => {
    const e = blotterLifecycleEvent(
      ticket({
        id: 'tp',
        status: 'booked',
        amountLocalM: 14.65,
        orderSide: 'Sell',
        bracketRole: 'takeProfit',
        basis: 'totalBuildup',
        limitRate: 1.157,
        ipaQuote: {
          strike: null,
          strikeInput: '',
          premiumUsd: null,
          premiumPercent: null,
          fxSpot: 1.152,
          fxOutright: 1.157,
          atmVolPercent: null,
          impliedVolPercent: null,
          deltaPercent: null,
        },
      }),
      'filled',
    );
    expect(e.summary).not.toBe('Sell EUR take profit booked');
    expect(e.summary).toMatch(/14\.65M/);
    expect(e.summary).toMatch(/limit/);
    expect(e.summary).toMatch(/notional/);
    expect(e.summary).toMatch(/WORKING|FILLED|BLOCKED/);
    expect(e.notionalUsdM).toBeGreaterThan(0);
  });

  it('replays a spot-referenced forward\'s spot limit against its spot execution', () => {
    // Sell stop at spot 1.16280, executed at spot 1.16250, booked as the M12
    // forward at 1.16250 + 170.1 pips = 1.17951. Replaying the forward rate
    // against the spot limit journalled this fill as never having reached it.
    const e = blotterLifecycleEvent(
      ticket({
        id: 'sr-sl',
        status: 'booked',
        orderSide: 'Sell',
        bracketRole: 'stopLoss',
        isSpotReferenced: true,
        stripLegPoints: 170.1,
        limitRate: 1.1628,
        filledAtMs: 10,
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
      'filled',
    );
    expect(e.summary).toMatch(/FILLED/);
    expect(e.summary).not.toMatch(/WORKING/);
    expect(e.summary).toContain('1.17951');
    expect(e.summary).not.toContain('booked at 1.16250');
  });
});

describe('spot-referenced fill audit line', () => {
  it('logs the booked forward as spot print plus the leg points, not the spot print', () => {
    // Hand check: 1.16250 + 170.1 pips = 1.16250 + 0.01701 = 1.17951.
    const d = explainRestingOrder(
      ticket({
        id: 'sr',
        orderSide: 'Sell',
        bracketRole: 'stopLoss',
        isSpotReferenced: true,
        stripLegPoints: 170.1,
        limitRate: 1.1628,
      }),
      { bid: 1.1625, ask: 1.1626, mid: 1.16255 },
      0,
      1,
    );
    expect(d.outcome).toBe('filled');
    expect(d.filledPx).toBe(1.17951);
    expect(d.reason).toContain('booked FWD at 1.17951 = spot 1.16250 +170.1 pts');
    expect(d.reason).not.toContain('booked at 1.16250');
  });
});

describe('liveCommittedUsdMByCcy', () => {
  it('counts live cover, not working orders', () => {
    const live = ticket({ id: 'live', status: 'booked', amountLocalM: 4 });
    const rest = ticket({ id: 'rest', amountLocalM: 3 });
    const quotes = new Map([[tapeQuoteKey(live), { bid: 1.1, ask: 1.1006, mid: 1.1 }]]);
    const map = liveCommittedUsdMByCcy([live, rest], quotes);
    expect(map.get('EUR')).toBeCloseTo(4 * 1.1, 6);
  });
});

describe('ticketLegExecLog', () => {
  it('logs LIVE on a compose ticket before BID/ASK', () => {
    const row = ticketLegExecLog({
      ticket: ticket({ id: 'compose', status: undefined, limitRate: undefined }),
      quote: { bid: 1.1783, ask: 1.1785, mid: 1.1784 },
      tape: '3M outright',
    });
    expect(row.phase).toBe('live');
    expect(row.summary).toMatch(/\[fx-exec\] LIVE/);
    expect(row.summary).toMatch(/tape 3M outright/);
    expect(row.summary).toMatch(/not submitted/);
  });

  it('reuses the matcher WORKING line with limit vs live bid', () => {
    const row = ticketLegExecLog({
      ticket: ticket({
        id: 'w',
        orderSide: 'Sell',
        bracketRole: 'stopLoss',
        limitRate: 1.177,
        orderHit: 'bid',
      }),
      quote: { bid: 1.1784, ask: 1.1786, mid: 1.1785 },
      tape: '3M outright',
      bank: 'CITI',
    });
    expect(row.phase).toBe('working');
    expect(row.summary).toMatch(/\[fx-exec\] WORKING Sell stopLoss/);
    expect(row.summary).toMatch(/limit 1\.17700 vs bid 1\.17840/);
    expect(row.summary).toMatch(/CITI/);
  });

  it('prefers an incoming matcher FILLED event', () => {
    const incoming = explainRestingOrder(
      ticket({ id: 'f', limitRate: 1.177, orderHit: 'bid' }),
      { bid: 1.1784, ask: 1.1786, mid: 1.1785 },
      0,
      20,
    );
    const row = ticketLegExecLog({
      ticket: ticket({ id: 'f', status: 'booked', filledAtMs: 20 }),
      incoming: { ...incoming, kind: 'order', summary: incoming.reason },
      tape: '3M outright',
    });
    expect(row.phase).toBe('filled');
    expect(row.summary).toMatch(/FILLED/);
  });
});

describe('eventsForTicketModal', () => {
  it('keeps matcher lines for this ticket and its OCO sibling', () => {
    const working = explainRestingOrder(ticket({ id: 'w', ocoGroupId: 'g1' }), quote, 0, 10);
    const other = explainRestingOrder(ticket({ id: 'z', ocoGroupId: 'g2' }), quote, 0, 10);
    const rows = eventsForTicketModal(
      [
        { ...working, kind: 'order', summary: working.reason },
        { ...other, kind: 'order', summary: other.reason },
      ],
      [ticket({ id: 'w', ocoGroupId: 'g1' })],
    );
    expect(rows.map(r => r.orderId)).toEqual(['w']);
  });
});

describe('explainWorkingOrders', () => {
  it('explains every scheduled ticket on the tape, including strip order legs', () => {
    const quotes = new Map([['EUR', quote]]);
    const rows = explainWorkingOrders(
      [
        ticket({ id: 'a' }),
        ticket({ id: 'b', status: 'booked' }),
        ticket({ id: 'c', stripId: 's1' }),
      ],
      quotes,
      1,
    );
    expect(rows.map(r => r.orderId).sort()).toEqual(['a', 'c']);
  });
});
