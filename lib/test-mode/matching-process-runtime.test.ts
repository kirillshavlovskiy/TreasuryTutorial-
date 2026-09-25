import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONSUMED_SHAPE_WINDOW_MS,
  MATCHING_INTERVAL_MS,
  WATCHED_CCY_TTL_MS,
  MatchingProcessRuntime,
} from './matching-process-runtime';
import { restingOrderHitSide, type HedgeTicket } from './hedge-var';
import {
  ingestLiveFxSpotQuote,
  resetFxSpotTapeForTests,
} from '@/lib/fx-spot-tape';

// Pass persistence through unchanged but observable — the durable consumed-
// order round-trip below needs to steer/inspect it without a database.
vi.mock('./matching-process-persist', async importOriginal => {
  const actual =
    await importOriginal<typeof import('./matching-process-persist')>();
  return {
    ...actual,
    loadConsumedOrders: vi.fn(actual.loadConsumedOrders),
    persistConsumedOrders: vi.fn(actual.persistConsumedOrders),
  };
});

function rest(partial: Partial<HedgeTicket> & Pick<HedgeTicket, 'id'>): HedgeTicket {
  return {
    ccy: 'EUR',
    instrument: 'forward',
    basis: 'stock',
    amountLocalM: 2.55,
    orderSide: 'Sell',
    orderHit: 'bid',
    status: 'scheduled',
    limitRate: 1.17,
    restingAnchorRate: 1.17,
    maturity: '1m',
    maturityLabel: '1M',
    varUsdM: 0,
    addressesHigherVar: false,
    ...partial,
  };
}

describe('MatchingProcessRuntime', () => {
  const runtimes: MatchingProcessRuntime[] = [];
  afterEach(() => {
    for (const r of runtimes) r.stop();
    runtimes.length = 0;
    resetFxSpotTapeForTests();
    vi.restoreAllMocks();
  });

  function runtime() {
    const r = new MatchingProcessRuntime();
    runtimes.push(r);
    return r;
  }

  it('records an open ticket\'s currency before any order exists', async () => {
    // Desk rule: the record starts when the tile is first engaged. A market
    // execution creates its order only at the fill, so keying recording off
    // orders alone left every live-executed chart empty before its own
    // fill print — the pre-execution stretch was never walked or served.
    const r = runtime();
    r.replaceUserOrders('desk@sigma.local', '02', [], {
      EUR: { bid: 1.16995, mid: 1.17, ask: 1.17005 },
    });
    await r.step();
    expect(r.tapeForUser('desk@sigma.local')['EUR|spot']).toBeUndefined();

    r.watchCcys('desk@sigma.local', '02', ['EUR']);
    await r.step();
    await r.step();
    const served = r.tapeForUser('desk@sigma.local');
    expect(served['EUR|spot']?.length ?? 0).toBeGreaterThan(0);
    // Scoped to the watching desk only.
    expect(r.tapeForUser('other@sigma.local')['EUR|spot']).toBeUndefined();
  });

  it('stops recording a watched currency once the ticket closes', async () => {
    const r = runtime();
    r.watchCcys('desk@sigma.local', '02', ['EUR']);
    await r.step();
    expect(r.tapeForUser('desk@sigma.local')['EUR|spot']?.length ?? 0)
      .toBeGreaterThan(0);
    // The panel stops refreshing the watch; past the TTL it lapses.
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(
      () => realNow() + WATCHED_CCY_TTL_MS + 1_000,
    );
    expect(r.tapeForUser('desk@sigma.local')['EUR|spot']).toBeUndefined();
  });

  it('advances lastTickAt without a browser session', async () => {
    const r = runtime();
    const before = r.heartbeat();
    expect(before.verdict).toBe('stopped');
    expect(before.independentOfBrowser).toBe(true);
    const probed = await r.probe(0);
    expect(probed.probe.browserRequired).toBe(false);
    expect(probed.probe.advanced).toBe(true);
    expect(probed.lastTickAt).toBeGreaterThan(probed.probe.firstTickAt ?? 0);
    expect(probed.tickCount).toBeGreaterThanOrEqual(1);
    expect(probed.intervalMs).toBe(MATCHING_INTERVAL_MS);
  });

  it('fills a resting sell when the node tape prints through the bid', async () => {
    const r = runtime();
    r.mergeSpots({ EUR: { bid: 1.17, mid: 1.1701, ask: 1.1702 } });
    r.replaceUserOrders('desk@sigma.local', '02', [
      rest({ id: 'eur-sell', limitRate: 1.16 }),
    ]);
    // Force a quote already through the sell limit.
    r.mergeSpots({ EUR: { bid: 1.18, mid: 1.1801, ask: 1.1802 } });
    await r.step();
    const fills = r.recentFillsForUser('desk@sigma.local');
    expect(fills.some(f => f.orderId === 'eur-sell' && f.outcome === 'filled')).toBe(
      true,
    );
    expect(r.heartbeat().workingOrders).toBe(0);
    const beat = r.heartbeat().lastBeat;
    expect(beat?.working).toBe(0);
    expect(beat?.filled).toBe(1);
    expect(beat?.summary).toMatch(/\[node\] BEAT/);
    expect(beat?.summary).toMatch(/1 triggered \(1 fill \/ 0 blocked\)/);
    const filledLine = r.heartbeat('desk@sigma.local').monitorEvents.find(
      e => e.kind === 'order' && e.outcome === 'filled',
    );
    expect(filledLine?.summary).toMatch(/FILLED/);
    expect(filledLine?.summary).toMatch(/crossed limit|booked at/);
    expect(filledLine?.summary).toMatch(/\$/);
  });

  it('does not refill the same order when the browser re-syncs it as scheduled', async () => {
    const r = runtime();
    const order = rest({
      id: 'eur-sell',
      limitRate: 1.16,
      ocoGroupId: 'oco-1',
    });
    const tp = rest({
      id: 'eur-tp',
      limitRate: 1.12,
      bracketRole: 'takeProfit',
      ocoGroupId: 'oco-1',
    });
    r.replaceUserOrders('desk@sigma.local', '02', [order, tp]);
    r.mergeSpots({ EUR: { bid: 1.18, mid: 1.1801, ask: 1.1802 } });
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(1);
    r.replaceUserOrders('desk@sigma.local', '02', [order, tp]);
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(1);
    expect(r.heartbeat().workingOrders).toBe(0);
  });

  it('does not teleport a forward stop onto spot and false-block it', async () => {
    const r = runtime();
    const sl = rest({
      id: 'eur-sl',
      ccy: 'EUR',
      orderSide: 'Sell',
      orderHit: 'bid',
      bracketRole: 'stopLoss',
      limitRate: 1.169,
      restingAnchorRate: 1.15231,
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
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [sl],
      { EUR: { bid: 1.1522, mid: 1.15231, ask: 1.1524 } },
    );
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(0);
    expect(r.heartbeat().workingOrders).toBe(1);
    const mid = r.heartbeat().lastTape?.mid;
    expect(mid).toBeGreaterThan(1.16);
    expect(mid).toBeLessThan(1.18);
  });

  it('does not fill a forward stop when the browser keeps posting the spot print', async () => {
    const r = runtime();
    // Stop sits 23.6 pips below the outright anchor — outside the walk's
    // ±18-pip cap — so the leg's own tape can never legitimately cross it;
    // the only thing that could fill this is the 1.152 spot print leaking in.
    const sl = rest({
      id: 'eur-sl-spot',
      bracketRole: 'stopLoss',
      limitRate: 1.167,
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
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [sl],
      { EUR: { bid: 1.1522, mid: 1.15231, ask: 1.1524 } },
    );
    await r.step();
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(0);
    expect(r.heartbeat().workingOrders).toBe(1);
    // The leg's own tape stayed on the outright convention throughout.
    // (tapeQuoteKey now normalizes the "1m" label to the months form.)
    const mid = r.quoteForKey('EUR|forward|t1.00')?.mid;
    expect(mid).toBeGreaterThan(1.167);
  });

  it('does not policy-block a forward stop on spot because a live option is already over the cap', async () => {
    const r = runtime();
    const live = rest({
      id: 'eur-opt',
      status: 'booked',
      instrument: 'option',
      amountLocalM: 12.1,
      restingAnchorRate: 1.15231,
    });
    const sl = rest({
      id: 'eur-sl-157',
      bracketRole: 'stopLoss',
      limitRate: 1.157,
      restingAnchorRate: 1.1575,
    });
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [live, sl],
      { EUR: { bid: 1.1525, mid: 1.15255, ask: 1.1526 } },
    );
    await r.step();
    await r.step();
    const notices = r.recentFillsForUser('desk@sigma.local');
    expect(notices.filter(n => n.outcome === 'blocked-policy')).toHaveLength(0);
    expect(notices.filter(n => n.outcome === 'filled')).toHaveLength(0);
    expect(r.heartbeat().workingOrders).toBe(1);
  });

  it('heartbeat is live only after start() and a tick', async () => {
    const r = runtime();
    await r.start();
    await r.step();
    const hb = r.heartbeat();
    expect(hb.isRunning).toBe(true);
    expect(hb.survivesBrowserClose).toBe(true);
    expect(hb.verdict).toBe('live');
    expect(hb.processAlive).toBe(true);
    r.stop();
    expect(r.heartbeat().verdict).toBe('stopped');
  });

  it('does not refill a clone of the same rest under a new ticket id', async () => {
    const r = runtime();
    const order = rest({ id: 'eur-sell', limitRate: 1.16 });
    r.replaceUserOrders('desk@sigma.local', '02', [order]);
    r.mergeSpots({ EUR: { bid: 1.18, mid: 1.1801, ask: 1.1802 } });
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local').filter(f => f.outcome === 'filled')).toHaveLength(1);
    r.replaceUserOrders('desk@sigma.local', '02', [
      rest({ id: 'eur-sell-clone', limitRate: 1.16 }),
    ]);
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local').filter(f => f.outcome === 'filled')).toHaveLength(1);
    expect(r.heartbeat().workingOrders).toBe(0);
  });

  it('does not resurrect a filled rest after a runtime restart', async () => {
    const persist = await import('./matching-process-persist');
    const r = runtime();
    const order = rest({ id: 'eur-sell-durable', limitRate: 1.16 });
    r.replaceUserOrders('desk@sigma.local', '02', [order]);
    r.mergeSpots({ EUR: { bid: 1.18, mid: 1.1801, ask: 1.1802 } });
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(1);
    // The consume reached the durable store on the fill beat.
    const persisted = vi
      .mocked(persist.persistConsumedOrders)
      .mock.calls.flatMap(call => [...call[0]]);
    expect(persisted.some(row => row.orderId === 'eur-sell-durable')).toBe(true);

    // A fresh runtime (HMR rev bump / restart) has empty in-memory sets;
    // start() reloads the durable rows, so the browser re-posting the stale
    // scheduled sandbox copy must not double-book it.
    vi.mocked(persist.loadConsumedOrders).mockResolvedValueOnce(persisted);
    const revived = runtime();
    await revived.start();
    revived.replaceUserOrders('desk@sigma.local', '02', [order]);
    revived.mergeSpots({ EUR: { bid: 1.18, mid: 1.1801, ask: 1.1802 } });
    await revived.step();
    expect(revived.recentFillsForUser('desk@sigma.local')).toHaveLength(0);
    expect(revived.heartbeat().workingOrders).toBe(0);
  });

  it('counts blotter live cover toward the auto cap after a book rebuild', async () => {
    const r = runtime();
    const live = [0, 1, 2, 3, 4, 5, 6].map(i =>
      rest({
        id: `eur-live-${i}`,
        status: 'booked',
        amountLocalM: 2.55,
        limitRate: 1.1699,
      }),
    );
    const working = rest({
      id: 'eur-tp-working',
      amountLocalM: 2.55,
      limitRate: 1.16,
    });
    r.replaceUserOrders('desk@sigma.local', '02', [...live, working]);
    r.mergeSpots({ EUR: { bid: 1.18, mid: 1.1801, ask: 1.1802 } });
    await r.step();
    const notices = r.recentFillsForUser('desk@sigma.local');
    expect(notices.filter(n => n.outcome === 'filled')).toHaveLength(0);
    expect(notices.filter(n => n.outcome === 'blocked-policy')).toHaveLength(1);
    expect(r.heartbeat().workingOrders).toBe(1);
  });

  it('logs an over-cap take-profit block once even when the browser re-syncs it', async () => {
    const r = runtime();
    const tp = rest({
      id: 'eur-tp-big',
      amountLocalM: 14.65,
      bracketRole: 'takeProfit',
      limitRate: 1.1575,
      restingAnchorRate: 1.1573,
    });
    r.replaceUserOrders('desk@sigma.local', '02', [tp]);
    r.mergeSpots({ EUR: { bid: 1.1600, mid: 1.1601, ask: 1.1602 } });
    await r.step();
    expect(
      r.recentFillsForUser('desk@sigma.local').filter(n => n.outcome === 'blocked-policy'),
    ).toHaveLength(1);
    r.replaceUserOrders('desk@sigma.local', '02', [
      rest({
        id: 'eur-tp-big-again',
        amountLocalM: 14.65,
        bracketRole: 'takeProfit',
        limitRate: 1.1575,
        restingAnchorRate: 1.1573,
      }),
    ]);
    r.mergeSpots({ EUR: { bid: 1.1605, mid: 1.1606, ask: 1.1607 } });
    await r.step();
    await r.step();
    expect(
      r.recentFillsForUser('desk@sigma.local').filter(n => n.outcome === 'blocked-policy'),
    ).toHaveLength(1);
    expect(r.heartbeat().workingOrders).toBe(1);
  });

  it('does not re-trigger a take-profit that is already live on the blotter', async () => {
    const r = runtime();
    const live = rest({
      id: 'gbp-tp-live',
      ccy: 'GBP',
      status: 'booked',
      amountLocalM: 5.08,
      bracketRole: 'takeProfit',
      limitRate: 1.25971,
      ocoGroupId: 'oco-gbp',
    });
    const clone = rest({
      id: 'gbp-tp-clone',
      ccy: 'GBP',
      amountLocalM: 5.08,
      bracketRole: 'takeProfit',
      limitRate: 1.25971,
      ocoGroupId: 'oco-gbp',
    });
    r.replaceUserOrders('desk@sigma.local', '02', [live, clone]);
    r.mergeSpots({ GBP: { bid: 1.261, mid: 1.2611, ask: 1.2612 } });
    await r.step();
    const notices = r.recentFillsForUser('desk@sigma.local');
    expect(notices.filter(n => n.outcome === 'filled')).toHaveLength(0);
    expect(notices.filter(n => n.outcome === 'blocked-policy')).toHaveLength(0);
    expect(r.heartbeat().workingOrders).toBe(0);
  });

  it('drops filled hold from the cap when the blotter no longer has the id', async () => {
    const r = runtime();
    r.replaceUserOrders('desk@sigma.local', '02', [
      rest({ id: 'eur-sell', limitRate: 1.16 }),
    ]);
    r.mergeSpots({ EUR: { bid: 1.18, mid: 1.1801, ask: 1.1802 } });
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local').some(f => f.outcome === 'filled')).toBe(true);
    r.replaceUserOrders('desk@sigma.local', '02', []);
    const next = rest({
      id: 'eur-new',
      amountLocalM: 8,
      limitRate: 1.16,
    });
    r.replaceUserOrders('desk@sigma.local', '02', [next]);
    r.mergeSpots({ EUR: { bid: 1.18, mid: 1.1801, ask: 1.1802 } });
    await r.step();
    expect(
      r.recentFillsForUser('desk@sigma.local').filter(f => f.orderId === 'eur-new' && f.outcome === 'filled'),
    ).toHaveLength(1);
  });

  it('does not fill a 9m strip stop on the EUR spot print', async () => {
    const r = runtime();
    const sl = rest({
      id: 'eur-sl-9m',
      maturity: '9m',
      maturityLabel: '9M',
      instrument: 'forward',
      bracketRole: 'stopLoss',
      amountLocalM: 1.99,
      limitRate: 1.17745,
      stripId: 'strip-eur',
      stripEdgeIndex: 3,
      maturityMonths: 7.4,
    });
    delete (sl as { restingAnchorRate?: number }).restingAnchorRate;
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [sl],
      { EUR: { bid: 1.1525, mid: 1.15254, ask: 1.1526 } },
    );
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(0);
    expect(r.heartbeat().workingOrders).toBe(1);
  });

  it('does not write a spot print onto a composite forward tape key', async () => {
    const r = runtime();
    const sl = rest({
      id: 'eur-3m-sl',
      instrument: 'forward',
      maturity: '3m',
      maturityMonths: 3,
      bracketRole: 'stopLoss',
      limitRate: 1.177,
      restingAnchorRate: 1.1784,
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.1648,
        fxOutright: 1.1784,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
      },
    });
    r.replaceUserOrders('desk@sigma.local', '02', [sl]);
    r.mergeSpots({
      'EUR|forward|t3.00': { bid: 1.16486, mid: 1.16487, ask: 1.16488 },
    });
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(0);
    expect(r.heartbeat().workingOrders).toBe(1);
    // The forward leg's own key must still sit on the outright convention
    // (anchor 1.1784, walk capped at ±18 pips), not the 1.1649 spot print.
    // lastTape is the map's first entry — the bare EUR spot feed — and says
    // nothing about this key.
    const mid = r.quoteForKey('EUR|forward|t3.00')?.mid;
    expect(mid).toBeGreaterThan(1.17);
  });

  it('fills a spot stop-loss on the shared spot tape at the posted spot print', async () => {
    const r = runtime();
    const sl = rest({
      id: 'eur-spot-sl',
      instrument: 'spot',
      maturity: null,
      maturityMonths: 0,
      bracketRole: 'stopLoss',
      limitRate: 1.1628,
      restingAnchorRate: 1.1648,
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.1648,
        fxOutright: null,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
      },
    });
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [sl],
      { EUR: { bid: 1.16475, mid: 1.1648, ask: 1.16485 } },
    );
    await r.step();
    // Own walk is capped ±18 pips around the 1.1648 seed — 20 pips away
    // cannot fill without a genuine spot print through the level.
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(0);
    expect(r.quoteForKey('EUR|spot')).not.toBeNull();
    r.mergeSpots({ EUR: { bid: 1.1625, mid: 1.16255, ask: 1.1626 } });
    await r.step();
    const fills = r.recentFillsForUser('desk@sigma.local');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.outcome).toBe('filled');
    // Sell stop fills on the bid of the spot tape at/through the level —
    // the exact print is the walked tape one beat after the posted spot,
    // never anything at the outright convention.
    const fillPx = fills[0]!.ticket.ipaQuote?.fxOutright;
    const fillSpot = fills[0]!.ticket.ipaQuote?.fxSpot;
    expect(fillPx).not.toBeNull();
    expect(fillPx!).toBeLessThanOrEqual(1.1628);
    expect(fillPx!).toBeGreaterThan(1.161);
    // The spot stamp is the executing print's own mid, one spread off the
    // fill side — not the stale pricing-time value 1.1648.
    expect(fillSpot).not.toBeNull();
    expect(Math.abs(fillSpot! - fillPx!)).toBeLessThan(0.0003);
  });

  it('fills a forward leg left on the spot tile off the spot tape and books spot + its points', async () => {
    const r = runtime();
    const sl = rest({
      id: 'eur-m12-spot-sl',
      instrument: 'forward',
      maturity: '1y',
      maturityMonths: 12,
      maturityLabel: 'L5 · M12',
      isSpotReferenced: true,
      stripLegPoints: 170.1,
      stripId: 'strip-eur-m12',
      stripEdgeIndex: 4,
      bracketRole: 'stopLoss',
      limitRate: 1.1628,
      restingAnchorRate: 1.1648,
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.1648,
        fxOutright: 1.1628,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
      },
    });
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [sl],
      { EUR: { bid: 1.16475, mid: 1.1648, ask: 1.16485 } },
    );
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(0);
    // Monitored on the shared spot tape — never on a walk of its own outright.
    expect(r.quoteForKey('EUR|spot')).not.toBeNull();
    expect(r.quoteForKey('EUR|forward|t12.00')).toBeNull();
    r.mergeSpots({ EUR: { bid: 1.1625, mid: 1.16255, ask: 1.1626 } });
    await r.step();
    const fills = r.recentFillsForUser('desk@sigma.local');
    expect(fills).toHaveLength(1);
    const booked = fills[0]!.ticket;
    // Booked as the M12 forward it was left for, like a live click on the leg.
    expect(booked.instrument).toBe('forward');
    expect(booked.maturityMonths).toBe(12);
    const spotPx = booked.ipaQuote?.fxSpot;
    expect(spotPx).not.toBeNull();
    expect(spotPx!).toBeLessThanOrEqual(1.1628);
    expect(spotPx!).toBeGreaterThan(1.161);
    // 170.1 EURUSD pips = 0.01701 on top of the spot execution.
    expect(booked.ipaQuote?.fxOutright).toBeCloseTo(spotPx! + 0.01701, 10);
  });

  it('registers a NEW order whose shape matches an already-filled one', async () => {
    // Consumption is by ticket id, not shape: hedgeRestingKey carries no id,
    // and gating on it swallowed every re-placed order at a level that had
    // ever filled once — POST /orders 200, matcher forever at 0 working.
    const r = runtime();
    const shape = {
      instrument: 'spot' as const,
      maturity: null,
      maturityMonths: 0,
      orderSide: 'Sell' as const,
      bracketRole: 'takeProfit' as const,
      limitRate: 1.163,
      restingAnchorRate: 1.1635,
    };
    const first = rest({ id: 'eur-tp-shape-1', ...shape });
    r.replaceUserOrders('desk@sigma.local', '02', [first], {
      EUR: { bid: 1.16345, mid: 1.1635, ask: 1.16355 },
    });
    await r.step();
    r.mergeSpots({ EUR: { bid: 1.1629, mid: 1.16295, ask: 1.163 } });
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(1);
    // Inside the anti-storm window a same-shape clone is still swallowed —
    // that is the resync protection, not the bug.
    const storm = rest({ id: 'eur-tp-shape-storm', ...shape });
    r.replaceUserOrders('desk@sigma.local', '02', [storm], {
      EUR: { bid: 1.16345, mid: 1.1635, ask: 1.16355 },
    });
    await r.step();
    expect(r.heartbeat().workingOrders).toBe(0);
    expect(
      r.recentFillsForUser('desk@sigma.local').filter(f => f.outcome === 'filled'),
    ).toHaveLength(1);
    // Past the window, the desk deliberately re-placing the same level is a
    // NEW order and must register — here it is already through the quote,
    // so registering means it FILLS on the next beat (cap-removal rule).
    const realNow = Date.now();
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow + CONSUMED_SHAPE_WINDOW_MS + 1_000);
    const second = rest({ id: 'eur-tp-shape-2', ...shape });
    r.replaceUserOrders('desk@sigma.local', '02', [second], {
      EUR: { bid: 1.16345, mid: 1.1635, ask: 1.16355 },
    });
    await r.step();
    expect(
      r.recentFillsForUser('desk@sigma.local').filter(f => f.outcome === 'filled'),
    ).toHaveLength(2);
    // The consumed ids still cannot resurrect, ever.
    r.replaceUserOrders('desk@sigma.local', '02', [first, second], {
      EUR: { bid: 1.16345, mid: 1.1635, ask: 1.16355 },
    });
    await r.step();
    expect(
      r.recentFillsForUser('desk@sigma.local').filter(f => f.outcome === 'filled'),
    ).toHaveLength(2);
    expect(r.heartbeat().workingOrders).toBe(0);
    nowSpy.mockRestore();
  });

  it('records tape for a booked leg that never rested', async () => {
    // A market-executed strip leg fills on the beat it is placed, so
    // upsertOrders (working rests only) never seeded its key and the
    // matcher recorded ZERO tape for it — the reopened chart had nothing to
    // show and tripped the blank-plot guard. A booked leg keeps a tape.
    const r = runtime();
    const booked = rest({
      id: 'eur-fwd-market-fill',
      status: 'booked',
      instrument: 'forward',
      maturity: '6m',
      maturityMonths: 5,
      limitRate: undefined,
      restingAnchorRate: 1.1725,
      filledAtMs: Date.now(),
    });
    const key = 'EUR|forward|t5.00';
    r.replaceUserOrders('desk@sigma.local', '02', [booked], {
      EUR: { bid: 1.16995, mid: 1.17, ask: 1.17005 },
    });
    expect(r.quoteForKey(key)).toBeNull();
    await r.step();
    // The leg's own outright key walks for MATCHING (live current quote)…
    const q = r.quoteForKey(key);
    expect(q).not.toBeNull();
    expect(q!.mid).toBeGreaterThan(1.17);
    // …but ONE tape is recorded and served per currency: the SPOT record.
    // The leg's displayed series is spot + its stamped points, derived in
    // the UI — forward keys are never persisted or served as history.
    const served = r.tapeForUser('desk@sigma.local');
    expect(served[key]).toBeUndefined();
    expect(served['EUR|spot']?.length ?? 0).toBeGreaterThan(0);
    await r.step();
    expect(r.tapeForUser('desk@sigma.local')['EUR|spot']!.length).toBeGreaterThan(1);
  });

  it('records and serves tape for a client-executed STRIP leg', async () => {
    // setLiveTicket deliberately skips stripId tickets and filledHold only
    // holds the matcher's own fills — so a strip leg executed through the
    // browser's leg-row click was invisible to every tape loop: never
    // walked, never recorded, never served. Its reopened chart was blank.
    const r = runtime();
    const leg = rest({
      id: 'eur-strip-leg-client-fill',
      status: 'booked',
      instrument: 'forward',
      maturity: '6m',
      maturityMonths: 4,
      limitRate: undefined,
      restingAnchorRate: 1.1718,
      filledAtMs: Date.now(),
      stripId: 'strip-EUR-client',
      stripEdgeIndex: 1,
    });
    const key = 'EUR|forward|t4.00';
    r.replaceUserOrders('desk@sigma.local', '02', [leg], {
      EUR: { bid: 1.16995, mid: 1.17, ask: 1.17005 },
    });
    await r.step();
    const q = r.quoteForKey(key);
    expect(q).not.toBeNull();
    expect(q!.mid).toBeGreaterThan(1.17);
    // Spot-only storage: the client-executed leg's story is attributed to
    // and served from the currency's spot record.
    const served = r.tapeForUser('desk@sigma.local');
    expect(served[key]).toBeUndefined();
    expect(served['EUR|spot']?.length ?? 0).toBeGreaterThan(0);
    await r.step();
    expect(r.tapeForUser('desk@sigma.local')['EUR|spot']!.length).toBeGreaterThan(1);
    // Past the story window the hold is dropped — no tape leak forever.
    const old = rest({
      id: 'eur-strip-leg-stale-fill',
      status: 'booked',
      instrument: 'forward',
      maturity: '9m',
      maturityMonths: 9,
      limitRate: undefined,
      restingAnchorRate: 1.174,
      filledAtMs: Date.now() - 10 * 60_000,
      stripId: 'strip-EUR-client',
      stripEdgeIndex: 2,
    });
    r.replaceUserOrders('desk@sigma.local', '02', [leg, old]);
    await r.step();
    expect(r.quoteForKey('EUR|forward|t9.00')).toBeNull();
  });

  it('guarantees the post-fill recording tail even when the browser clears the book', async () => {
    // The desk is guaranteed 60-120s of tape after every execution. The
    // hold is registered by the SERVER at the fill; a browser payload that
    // clears the book (or omits the just-filled ticket) must not stop the
    // recording mid-tail, and bracket fills are held like any other.
    const r = runtime();
    const tp = rest({
      id: 'eur-tail-tp',
      instrument: 'spot',
      maturity: null,
      maturityMonths: 0,
      bracketRole: 'takeProfit',
      limitRate: 1.163,
      restingAnchorRate: 1.1635,
    });
    r.replaceUserOrders('desk@sigma.local', '02', [tp], {
      EUR: { bid: 1.16345, mid: 1.1635, ask: 1.16355 },
    });
    await r.step();
    r.mergeSpots({ EUR: { bid: 1.1629, mid: 1.16295, ask: 1.163 } });
    await r.step();
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(1);
    // Browser clears the book entirely right after the fill.
    r.replaceUserOrders('desk@sigma.local', '02', [], {});
    await r.step();
    await r.step();
    const served = r.tapeForUser('desk@sigma.local');
    expect(Object.keys(served)).toContain('EUR|spot');
    expect(served['EUR|spot']!.length).toBeGreaterThan(0);
    // The key is still being walked by the engine, not just replayed.
    expect(r.quoteForKey('EUR|spot')).not.toBeNull();
  });

  it('keeps a filled order on the tile it was typed into', async () => {
    // orderHit names the UI tile the level was typed into, never the market
    // side the trade executes on (see its doc on HedgeTicket). A BUY EUR
    // take-profit is typed on the bid tile and (2026-09-08 desk instruction:
    // take-profit fills at the opposite side from stop-loss/plain) also
    // executes against the bid, so overwriting orderHit with the execution
    // side moved the filled leg onto its stop-loss sibling's card and left
    // both cards titled TAKE PROFIT.
    const r = runtime();
    const tp = rest({
      id: 'eur-spot-tp-tile',
      instrument: 'spot',
      maturity: null,
      maturityMonths: 0,
      orderSide: 'Buy',
      amountLocalM: -2.55,
      orderHit: 'bid',
      bracketRole: 'takeProfit',
      limitRate: 1.1628,
      restingAnchorRate: 1.1628,
    });
    // A Buy take-profit executes on the bid — the tile it rests on is the
    // other one (see restingOrderHitSide's take-profit inversion).
    expect(restingOrderHitSide(tp)).toBe('bid');
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [tp],
      { EUR: { bid: 1.16275, mid: 1.1628, ask: 1.16285 } },
    );
    await r.step();
    r.mergeSpots({ EUR: { bid: 1.1620, mid: 1.16205, ask: 1.1621 } });
    await r.step();
    const fills = r.recentFillsForUser('desk@sigma.local');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.outcome).toBe('filled');
    expect(fills[0]!.ticket.orderHit).toBe('bid');
    expect(fills[0]!.ticket.bracketRole).toBe('takeProfit');
  });

  it('does not let an outright-stamped spot bracket park the shared spot tape at the forward level', async () => {
    const r = runtime();
    const sl = rest({
      id: 'eur-spot-sl-outright',
      instrument: 'spot',
      maturity: null,
      maturityMonths: 0,
      bracketRole: 'stopLoss',
      limitRate: 1.177,
      restingAnchorRate: 1.1784,
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.1648,
        fxOutright: 1.1784,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
      },
    });
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [sl],
      { EUR: { bid: 1.16475, mid: 1.1648, ask: 1.16485 } },
    );
    await r.step();
    await r.step();
    // 40-pip order cap removed (2026-09-08): a sell stop resting ABOVE the
    // spot bid is already through and fills at once on the spot print —
    // it no longer sits dead because its level looks outright-flavored.
    const fills = r.recentFillsForUser('desk@sigma.local');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.ticket.ipaQuote?.fxOutright).toBeLessThan(1.17);
    // The FEED protection is unchanged and is the actual point: the shared
    // spot tape seeds from the ticket's stamped SPOT (1.1648) and keeps
    // taking the live feed — it must never park at the outright stamps
    // (1.1784), fill or no fill.
    const mid = r.quoteForKey('EUR|spot')?.mid;
    expect(mid).toBeDefined();
    expect(mid!).toBeLessThan(1.17);
  });

  it('lets the live spot feed correct the shared tape instead of re-parking on order stamps', async () => {
    const r = runtime();
    const sl = rest({
      id: 'eur-spot-sl-drift',
      instrument: 'spot',
      maturity: null,
      maturityMonths: 0,
      bracketRole: 'stopLoss',
      limitRate: 1.1628,
      restingAnchorRate: 1.1648,
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.1648,
        fxOutright: null,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
      },
    });
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [sl],
      { EUR: { bid: 1.16475, mid: 1.1648, ask: 1.16485 } },
    );
    await r.step();
    // The market gaps 60 pips above the placement stamps. The browser's
    // next sync carries the new live spot — the shared tape must follow it,
    // not get re-parked at the order's stale 1.1648 stamp every beat.
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [sl],
      { EUR: { bid: 1.17075, mid: 1.1708, ask: 1.17085 } },
    );
    await r.step();
    const mid = r.quoteForKey('EUR|spot')?.mid;
    expect(mid).toBeDefined();
    expect(mid!).toBeGreaterThan(1.169);
    // A sell stop far BELOW the market must not fire on the way up.
    expect(r.recentFillsForUser('desk@sigma.local')).toHaveLength(0);
  });

  it('serves the recorded spot tape to every owner working the key, none to bystanders', async () => {
    const r = runtime();
    const sl = rest({
      id: 'eur-spot-sl-tape',
      instrument: 'spot',
      maturity: null,
      maturityMonths: 0,
      bracketRole: 'stopLoss',
      limitRate: 1.1628,
      restingAnchorRate: 1.1648,
    });
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [sl],
      { EUR: { bid: 1.16475, mid: 1.1648, ask: 1.16485 } },
    );
    // A second owner working the same shared key sees the same series — it
    // is one market tape, not per-user data.
    r.replaceUserOrders('peer@sigma.local', '02', [
      rest({
        id: 'eur-spot-tp-peer',
        instrument: 'spot',
        maturity: null,
        maturityMonths: 0,
        bracketRole: 'takeProfit',
        limitRate: 1.1668,
        restingAnchorRate: 1.1648,
      }),
    ]);
    await r.step();
    await r.step();
    const tape = r.tapeForUser('desk@sigma.local');
    expect(Object.keys(tape)).toContain('EUR|spot');
    expect(tape['EUR|spot']!.length).toBeGreaterThanOrEqual(2);
    expect(tape['EUR|spot']!.every(p => p.mid > 0 && p.t > 0)).toBe(true);
    expect(r.tapeForUser('peer@sigma.local')['EUR|spot']).toEqual(tape['EUR|spot']);
    // A user with no working/live ticket gets nothing — keys reveal that
    // orders exist, so they are served only to owners.
    expect(Object.keys(r.tapeForUser('someone-else@sigma.local'))).toHaveLength(0);
  });

  it('does not fill a far strip tenor from a nearer-leg print when both bucket as 9m', async () => {
    const r = runtime();
    const l3 = rest({
      id: 'eur-l3',
      maturity: '9m',
      maturityMonths: 6.3,
      instrument: 'forward',
      bracketRole: 'stopLoss',
      amountLocalM: 3.3,
      limitRate: 1.173,
      stripId: 'strip-eur',
      stripEdgeIndex: 2,
    });
    const l8 = rest({
      id: 'eur-l8',
      maturity: '9m',
      maturityMonths: 8.2,
      instrument: 'forward',
      bracketRole: 'stopLoss',
      amountLocalM: 0.02,
      limitRate: 1.1785,
      stripId: 'strip-eur',
      stripEdgeIndex: 7,
    });
    delete (l3 as { restingAnchorRate?: number }).restingAnchorRate;
    delete (l8 as { restingAnchorRate?: number }).restingAnchorRate;
    r.replaceUserOrders(
      'desk@sigma.local',
      '02',
      [l3, l8],
      { EUR: { bid: 1.17279, mid: 1.17285, ask: 1.17291 } },
    );
    await r.step();
    const fills = r.recentFillsForUser('desk@sigma.local');
    expect(fills.some(f => f.orderId === 'eur-l8')).toBe(false);
    expect(r.heartbeat().workingOrders).toBeGreaterThanOrEqual(1);
  });

  it('puts WORKING size/limit/ask/notional on the heartbeat monitor, not a policy block', async () => {
    const r = runtime();
    r.mergeSpots({ EUR: { bid: 1.10, mid: 1.1001, ask: 1.1002 } });
    r.replaceUserOrders('desk@sigma.local', '02', [
      rest({
        id: 'eur-tp',
        amountLocalM: 5,
        bracketRole: 'takeProfit',
        limitRate: 1.20,
        restingAnchorRate: 1.1995,
      }),
    ]);
    r.mergeSpots({ EUR: { bid: 1.1994, mid: 1.1995, ask: 1.1996 } });
    await r.step();
    const lines = r.heartbeat('desk@sigma.local').monitorEvents.filter(e => e.kind === 'order');
    expect(lines.some(e => e.outcome === 'blocked-policy')).toBe(false);
    const working = lines.find(e => e.outcome === 'working');
    expect(working?.summary).toMatch(/WORKING/);
    expect(working?.summary).toMatch(/5\.00M/);
    expect(working?.summary).toMatch(/limit/);
    // Sell take-profit fills at the opposite side from a plain/stop order —
    // 2026-09-08 desk instruction.
    expect(working?.summary).toMatch(/ask/);
    expect(working?.summary).toMatch(/notional/);
    expect(working?.summary).toMatch(/\$/);
  });

  it('does not fill a strip cover rest on an edge that already printed live', async () => {
    const r = runtime();
    const live = rest({
      id: 'eur-m1-live',
      status: 'booked',
      stripId: 'strip-a',
      stripEdgeIndex: 0,
      filledAtMs: 1,
      orderHit: 'bid',
      limitRate: 1.16,
    });
    const dup = rest({
      id: 'eur-m1-leave',
      stripId: 'strip-a',
      stripEdgeIndex: 0,
      limitRate: 1.16,
    });
    const remaining = rest({
      id: 'eur-m3-leave',
      stripId: 'strip-a',
      stripEdgeIndex: 2,
      limitRate: 1.16,
    });
    r.replaceUserOrders('desk@sigma.local', '02', [live, dup, remaining]);
    r.mergeSpots({ EUR: { bid: 1.18, mid: 1.1801, ask: 1.1802 } });
    await r.step();
    const fills = r.recentFillsForUser('desk@sigma.local').filter(f => f.outcome === 'filled');
    expect(fills.map(f => f.orderId)).toEqual(['eur-m3-leave']);
    expect(r.heartbeat().workingOrders).toBe(0);
  });

  it('walks the shared fx-spot tape around last live and does not snap on a stale re-post', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const live = { bid: 1.1622, mid: 1.1623, ask: 1.1624 };
    ingestLiveFxSpotQuote({
      pair: 'EURUSD',
      live,
      asOf: '2026-09-07T12:00:00Z',
      nowMs: Date.now() - 2_500,
    });
    const r = runtime();
    r.mergeSpots({ EUR: live, 'EUR|spot': live });
    await r.step();
    const q = r.quoteForKey('EUR|spot') ?? r.quoteForKey('EUR');
    expect(q).toBeTruthy();
    expect(q!.bid).toBeLessThan(q!.ask);
    expect(q!.mid).not.toBe(live.mid);
    expect(q!.mid).toBeGreaterThan(1.16);
    expect(Math.abs(q!.mid - 1.1557)).toBeGreaterThan(0.005);
    const walked = q!.mid;
    r.mergeSpots({ EUR: live, 'EUR|spot': live });
    expect((r.quoteForKey('EUR|spot') ?? r.quoteForKey('EUR'))!.mid).toBe(walked);
  });
});

describe('MatchingProcessRuntime — a resting forward order\'s stamps', () => {
  const runtimes: MatchingProcessRuntime[] = [];
  afterEach(() => {
    for (const r of runtimes) r.stop();
    runtimes.length = 0;
    resetFxSpotTapeForTests();
    vi.restoreAllMocks();
  });

  // EUR 6.86m forward leg: live spot 1.1411, leg points 97.6 → outright
  // 1.15086. A Sell take-profit left 31 pips above the leg's own market.
  const live = { bid: 1.1410, mid: 1.1411, ask: 1.1412 };
  const outright = 1.1411 + 0.00976;
  const limit = 1.1540;

  async function placeWithStamp(fxOutright: number) {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    ingestLiveFxSpotQuote({
      pair: 'EURUSD',
      live,
      asOf: '2026-09-23T12:00:00Z',
      nowMs: Date.now(),
    });
    const r = new MatchingProcessRuntime();
    runtimes.push(r);
    r.mergeSpots({ EUR: live, 'EUR|spot': live });
    r.replaceUserOrders('desk@sigma.local', '02', [
      rest({
        id: 'eur-l4-tp',
        amountLocalM: 1.3188,
        bracketRole: 'takeProfit',
        orderType: 'takeProfit',
        orderHit: 'ask',
        maturity: null,
        maturityMonths: 6.86,
        maturityLabel: 'L4 · 6.9m',
        limitRate: limit,
        restingAnchorRate: outright,
        ipaQuote: {
          strike: null,
          strikeInput: 'ATMF',
          premiumUsd: null,
          premiumPercent: null,
          fxSpot: live.mid,
          fxOutright,
          atmVolPercent: null,
          impliedVolPercent: null,
          deltaPercent: null,
        },
      }),
    ]);
    await r.step();
    await r.step();
    return r;
  }

  it('stamped with the leg\'s own outright, it rests 31 pips off its market', async () => {
    const r = await placeWithStamp(outright);
    expect(r.recentFillsForUser('desk@sigma.local').filter(f => f.outcome === 'filled')).toHaveLength(0);
    expect(r.heartbeat().workingOrders).toBe(1);
  });

  it('stamped with its own limit as fxOutright (the old leave stamp), it filled at placement', async () => {
    // fxOutright − fxSpot became limit − spot, so the order's own trigger
    // tape was built sitting on its limit: it fired the moment it rested,
    // on a market that never went near the level.
    const r = await placeWithStamp(limit);
    expect(r.recentFillsForUser('desk@sigma.local').filter(f => f.outcome === 'filled')).toHaveLength(1);
  });
});

describe('MatchingProcessRuntime monitor — one desk\'s book per viewer', () => {
  const runtimes: MatchingProcessRuntime[] = [];
  afterEach(() => {
    for (const r of runtimes) r.stop();
    runtimes.length = 0;
    resetFxSpotTapeForTests();
    vi.restoreAllMocks();
  });

  function runtime() {
    const r = new MatchingProcessRuntime();
    runtimes.push(r);
    return r;
  }

  /** Two desks, each with one take-profit resting short of the market. */
  async function twoDesksWorking() {
    const r = runtime();
    r.mergeSpots({ EUR: { bid: 1.10, mid: 1.1001, ask: 1.1002 } });
    r.replaceUserOrders('alice@example.com', '02', [
      rest({
        id: 'alice-tp',
        amountLocalM: 5,
        bracketRole: 'takeProfit',
        limitRate: 1.20,
        restingAnchorRate: 1.1995,
      }),
    ]);
    r.replaceUserOrders('bob@example.com', '02', [
      rest({
        id: 'bob-tp',
        amountLocalM: 3,
        bracketRole: 'takeProfit',
        limitRate: 1.21,
        restingAnchorRate: 1.1995,
      }),
    ]);
    r.mergeSpots({ EUR: { bid: 1.1994, mid: 1.1995, ask: 1.1996 } });
    await r.step();
    return r;
  }

  function orderIds(events: readonly { kind: string; orderId?: string }[]): string[] {
    return events.flatMap(e => (e.kind === 'order' && e.orderId ? [e.orderId] : []));
  }

  it('shows each desk its own working order and never the other desk\'s', async () => {
    const r = await twoDesksWorking();
    expect(orderIds(r.heartbeat('alice@example.com').monitorEvents)).toEqual(['alice-tp']);
    expect(orderIds(r.heartbeat('bob@example.com').monitorEvents)).toEqual(['bob-tp']);
  });

  it('shows no order lines to a desk with no orders, or to a caller with no identity', async () => {
    const r = await twoDesksWorking();
    expect(orderIds(r.heartbeat('carol@example.com').monitorEvents)).toEqual([]);
    expect(orderIds(r.heartbeat().monitorEvents)).toEqual([]);
    expect(orderIds(r.heartbeat(null).monitorEvents)).toEqual([]);
  });

  it('matches the viewer to the order owner regardless of email case', async () => {
    const r = await twoDesksWorking();
    expect(orderIds(r.heartbeat('Alice@Example.COM').monitorEvents)).toEqual(['alice-tp']);
  });

  it('scopes a probe the same way as a heartbeat', async () => {
    const r = await twoDesksWorking();
    expect(orderIds((await r.probe(0, 'alice@example.com')).monitorEvents)).toEqual(['alice-tp']);
    expect(orderIds((await r.probe(0, 'carol@example.com')).monitorEvents)).toEqual([]);
    expect(orderIds((await r.probe(0)).monitorEvents)).toEqual([]);
  });

  it('shows a fill to its own desk only, while the process beat reaches every desk', async () => {
    const r = runtime();
    r.mergeSpots({ EUR: { bid: 1.17, mid: 1.1701, ask: 1.1702 } });
    r.replaceUserOrders('alice@example.com', '02', [
      rest({ id: 'alice-sell', limitRate: 1.16 }),
    ]);
    r.mergeSpots({ EUR: { bid: 1.18, mid: 1.1801, ask: 1.1802 } });
    await r.step();

    const alice = r.heartbeat('alice@example.com').monitorEvents;
    expect(alice.some(e => e.kind === 'order' && e.orderId === 'alice-sell' && e.outcome === 'filled'))
      .toBe(true);

    const bob = r.heartbeat('bob@example.com').monitorEvents;
    expect(orderIds(bob)).toEqual([]);
    expect(bob.some(e => e.kind === 'beat')).toBe(true);
  });
});
