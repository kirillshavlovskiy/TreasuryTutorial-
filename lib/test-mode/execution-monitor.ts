import { isUsdPerFcyQuoted } from '@/lib/fx-market-rates';
import {
  overlayTapeConventionLabel,
  tapeFillPrint,
  tapeQuoteKey,
} from '@/lib/test-mode/tape-candles';
import {
  AUTOMATED_HEDGE_LIMIT_USD_M,
  autoFillAllowedByPolicy,
  restingOrderHitSide,
  restingOrderTriggersAt,
  spotReferencedFillQuote,
  ticketNotionalUsdM,
  usdPerLocalFromQuote,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';

export type ExecOrderOutcome =
  | 'working'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'blocked-policy'
  | 'skipped';

export type ExecSkipReason =
  | 'not-scheduled'
  | 'strip-leg'
  | 'no-quote'
  | 'no-level'
  | 'not-triggered';

export type MarketQuote = { bid: number; ask: number; mid: number };

export type ExecutionDecision = {
  atMs: number;
  orderId: string;
  ccy: string;
  outcome: ExecOrderOutcome;
  skipReason?: ExecSkipReason;
  basis: string;
  instrument: string;
  maturityLabel: string | null;
  orderSide: 'Buy' | 'Sell' | null;
  hitSide: 'bid' | 'ask' | null;
  bracketRole: 'takeProfit' | 'stopLoss' | null;
  ocoGroupId: string | null;
  limitRate: number | null;
  marketBid: number | null;
  marketAsk: number | null;
  marketMid: number | null;
  triggerPx: number | null;
  filledPx: number | null;
  distancePips: number | null;
  amountLocalM: number;
  notionalUsdM: number;
  committedUsdM: number;
  policyCapUsdM: number;
  autoFillAllowed: boolean | null;
  quoteConvention: 'usd-per-fcy' | 'fcy-per-usd';
  reason: string;
};

export type ExecutionBeatEvent = {
  kind: 'beat';
  atMs: number;
  elapsedMs: number;
  ccyCount: number;
  working: number;
  triggered: number;
  filled: number;
  blocked: number;
  summary: string;
};

export type ExecutionOrderEvent = ExecutionDecision & {
  kind: 'order';
  summary: string;
};

export type ExecutionLogEvent = ExecutionBeatEvent | ExecutionOrderEvent;

export const EXEC_LOG_TAG = '[fx-exec]';

function pipSizeOf(px: number): number {
  return px >= 20 ? 0.01 : 0.0001;
}

function fmtPx(px: number | null): string {
  if (px == null || !Number.isFinite(px)) return '—';
  return px >= 20 ? px.toFixed(4) : px.toFixed(5);
}

function sideOf(ticket: HedgeTicket): 'Buy' | 'Sell' {
  return ticket.orderSide ?? (ticket.amountLocalM >= 0 ? 'Sell' : 'Buy');
}

export function liveCommittedUsdMByCcy(
  tickets: readonly HedgeTicket[],
  quotes: ReadonlyMap<string, MarketQuote>,
): Map<string, number> {
  const committed = new Map<string, number>();
  for (const t of tickets) {
    if (t.status === 'scheduled' || t.stripId) continue;
    const q = quotes.get(tapeQuoteKey(t));
    if (!q) continue;
    const usd = ticketNotionalUsdM(t, usdPerLocalFromQuote(t.ccy, q.mid));
    committed.set(t.ccy, (committed.get(t.ccy) ?? 0) + usd);
  }
  return committed;
}

export function explainRestingOrder(
  ticket: HedgeTicket,
  quote: MarketQuote | undefined,
  committedUsdM: number,
  atMs = Date.now(),
  forceTriggered = false,
): ExecutionDecision {
  const convention = isUsdPerFcyQuoted(ticket.ccy)
    ? 'usd-per-fcy'
    : 'fcy-per-usd';
  const orderSide = sideOf(ticket);
  const base = {
    atMs,
    orderId: ticket.id,
    ccy: ticket.ccy,
    basis: ticket.basis,
    instrument: ticket.instrument,
    maturityLabel: ticket.maturityLabel,
    orderSide,
    bracketRole: ticket.bracketRole ?? null,
    ocoGroupId: ticket.ocoGroupId ?? null,
    limitRate: ticket.limitRate ?? null,
    amountLocalM: ticket.amountLocalM,
    committedUsdM,
    policyCapUsdM: AUTOMATED_HEDGE_LIMIT_USD_M,
    quoteConvention: convention,
  } as const;

  if (ticket.status !== 'scheduled') {
    return finish({
      ...base,
      outcome: 'skipped',
      skipReason: 'not-scheduled',
      hitSide: null,
      marketBid: quote?.bid ?? null,
      marketAsk: quote?.ask ?? null,
      marketMid: quote?.mid ?? null,
      triggerPx: null,
      filledPx: null,
      distancePips: null,
      notionalUsdM: 0,
      autoFillAllowed: null,
      reason: `${ticket.ccy} ${ticket.id} is ${ticket.status ?? 'live'} — monitor ignores it`,
    });
  }
  if (!quote) {
    return finish({
      ...base,
      outcome: 'skipped',
      skipReason: 'no-quote',
      hitSide: null,
      marketBid: null,
      marketAsk: null,
      marketMid: null,
      triggerPx: null,
      filledPx: null,
      distancePips: null,
      notionalUsdM: 0,
      autoFillAllowed: null,
      reason: `${ticket.ccy} has no tape quote this beat`,
    });
  }

  const hitSide = restingOrderHitSide(ticket);
  const triggerPx = hitSide === 'bid' ? quote.bid : quote.ask;
  const usdPerLocal = usdPerLocalFromQuote(ticket.ccy, quote.mid);
  const notionalUsdM = ticketNotionalUsdM(ticket, usdPerLocal);
  const pip = pipSizeOf(triggerPx);
  const limit = ticket.limitRate;

  if (limit == null || !Number.isFinite(limit) || limit <= 0) {
    return finish({
      ...base,
      outcome: 'skipped',
      skipReason: 'no-level',
      hitSide,
      marketBid: quote.bid,
      marketAsk: quote.ask,
      marketMid: quote.mid,
      triggerPx,
      filledPx: null,
      distancePips: null,
      notionalUsdM,
      autoFillAllowed: null,
      reason: `${orderSide} ${ticket.ccy} ${ticket.instrument} on ${ticket.basis} has no limit`,
    });
  }

  const triggered = forceTriggered || restingOrderTriggersAt(ticket, quote);
  /**
   * Signed so POSITIVE always reads "the market still has this far to travel
   * before this order triggers", and negative "already through", for every
   * order type in the same `[fx-exec]` line.
   *
   * This used to derive the sign from `hitSide` alone, which silently assumed
   * the sampled quote side also names the trigger DIRECTION. It never did for
   * a stop-loss (same side as a plain order, opposite direction), and since
   * the 2026-09-08 take-profit side flip it does not for a take-profit either
   * (opposite side, same direction) — so a WORKING take-profit was reported at
   * a negative distance and a FILLED one at a positive distance, the reverse
   * of every plain order beside it. Verified against real recorded EUR|spot
   * tape: a sell TP at 1.16310 against ask 1.16309770 printed −0.023 pips
   * while still working, and +0.176 pips on the tick that filled it.
   *
   * `restingOrderTriggersAt` is the single authority on the direction, so the
   * sign is taken from its answer rather than re-derived here — one less
   * place that can drift from the trigger rule.
   */
  const distancePips =
    triggerPx > 0
      ? (triggered ? -1 : 1) * (Math.abs(limit - triggerPx) / pip)
      : null;
  const allowed = autoFillAllowedByPolicy(ticket, usdPerLocal, committedUsdM);
  const role = ticket.bracketRole ? ` ${ticket.bracketRole}` : '';
  const conv = convention === 'usd-per-fcy' ? 'USD per FCY' : 'FCY per USD';
  const dist =
    distancePips != null
      ? `${distancePips >= 0 ? '+' : ''}${distancePips.toFixed(1)} pips`
      : '—';

  if (!triggered) {
    return finish({
      ...base,
      outcome: 'working',
      skipReason: 'not-triggered',
      hitSide,
      marketBid: quote.bid,
      marketAsk: quote.ask,
      marketMid: quote.mid,
      triggerPx,
      filledPx: null,
      distancePips,
      notionalUsdM,
      autoFillAllowed: allowed,
      reason:
        `WORKING ${orderSide}${role} ${ticket.ccy} ${Math.abs(ticket.amountLocalM).toFixed(2)}M ${ticket.instrument} on ${ticket.basis}`
        + ` · limit ${fmtPx(limit)} vs ${hitSide} ${fmtPx(triggerPx)} (${dist})`
        + ` · ${conv} · notional $${notionalUsdM.toFixed(2)}M`,
    });
  }

  if (!allowed) {
    return finish({
      ...base,
      outcome: 'blocked-policy',
      hitSide,
      marketBid: quote.bid,
      marketAsk: quote.ask,
      marketMid: quote.mid,
      triggerPx,
      filledPx: null,
      distancePips,
      notionalUsdM,
      autoFillAllowed: false,
      reason:
        `BLOCKED ${orderSide}${role} ${ticket.ccy} ${Math.abs(ticket.amountLocalM).toFixed(2)}M ${ticket.instrument} on ${ticket.basis}`
        + ` · ${hitSide} ${fmtPx(triggerPx)} crossed ${fmtPx(limit)}`
        + ` · notional $${notionalUsdM.toFixed(2)}M + committed $${committedUsdM.toFixed(2)}M > $${AUTOMATED_HEDGE_LIMIT_USD_M}M auto cap`
        + (ticket.instrument === 'option' ? ' · options always need FX Lead' : ' · needs FX Lead + CFO'),
    });
  }

  // A spot-referenced forward executes on spot and books spot + its leg's
  // points: log the booked forward and how it was built, never the spot
  // print as the booked rate.
  const bookedForward =
    triggerPx != null ? spotReferencedFillQuote(ticket, triggerPx) : null;
  const points = ticket.stripLegPoints ?? 0;
  const bookedText = bookedForward
    ? `booked FWD at ${fmtPx(bookedForward.fxOutright)} = spot ${fmtPx(triggerPx)}`
      + ` ${points >= 0 ? '+' : '−'}${Math.abs(points).toFixed(1)} pts`
    : `booked at ${fmtPx(triggerPx)}`;
  return finish({
    ...base,
    outcome: 'filled',
    hitSide,
    marketBid: quote.bid,
    marketAsk: quote.ask,
    marketMid: quote.mid,
    triggerPx,
    filledPx: bookedForward?.fxOutright ?? triggerPx,
    distancePips,
    notionalUsdM,
    autoFillAllowed: true,
    reason:
      `FILLED ${orderSide}${role} ${ticket.ccy} ${Math.abs(ticket.amountLocalM).toFixed(2)}M ${ticket.instrument} on ${ticket.basis}`
      + ` · ${hitSide} ${fmtPx(triggerPx)} crossed limit ${fmtPx(limit)}`
      + ` · ${bookedText} · $${notionalUsdM.toFixed(2)}M ≤ $${AUTOMATED_HEDGE_LIMIT_USD_M}M auto cap`
      + ` · ${conv}`,
  });
}

function finish(
  d: Omit<ExecutionDecision, never>,
): ExecutionDecision {
  return d;
}

export function explainWorkingOrders(
  tickets: readonly HedgeTicket[],
  quotes: ReadonlyMap<string, MarketQuote>,
  atMs = Date.now(),
): ExecutionDecision[] {
  const committed = liveCommittedUsdMByCcy(tickets, quotes);
  return tickets
    .filter(t => t.status === 'scheduled')
    .map(t =>
      explainRestingOrder(
        t,
        quotes.get(tapeQuoteKey(t)),
        committed.get(t.ccy) ?? 0,
        atMs,
      ),
    );
}

export function beatEvent(
  decisions: readonly ExecutionDecision[],
  elapsedMs: number,
  ccyCount: number,
  atMs = Date.now(),
): ExecutionBeatEvent {
  const working = decisions.filter(d => d.outcome === 'working').length;
  const filled = decisions.filter(d => d.outcome === 'filled').length;
  const blocked = decisions.filter(d => d.outcome === 'blocked-policy').length;
  const triggered = filled + blocked;
  return {
    kind: 'beat',
    atMs,
    elapsedMs,
    ccyCount,
    working,
    triggered,
    filled,
    blocked,
    summary:
      `BEAT ${elapsedMs.toFixed(1)}ms · ${ccyCount} CCY · ${working} working · ${triggered} triggered (${filled} fill / ${blocked} blocked)`,
  };
}

export function nodeBeatStatusLine(input: {
  elapsedMs: number;
  ccyCount: number;
  working: number;
  filled: number;
  blocked: number;
}): string {
  const triggered = input.filled + input.blocked;
  return (
    `[node] BEAT ${input.elapsedMs.toFixed(1)}ms · ${input.ccyCount} CCY · ${input.working} working`
    + ` · ${triggered} triggered (${input.filled} fill / ${input.blocked} blocked)`
  );
}

export function toOrderEvent(d: ExecutionDecision): ExecutionOrderEvent {
  return { ...d, kind: 'order', summary: d.reason };
}

export type TicketLegExecPhase =
  | 'live'
  | 'working'
  | 'filled'
  | 'held'
  | 'rejected'
  | 'cancelled';

export type TicketLegExecLog = {
  orderId: string;
  edgeIndex: number | null;
  phase: TicketLegExecPhase;
  summary: string;
  atMs: number;
  event: ExecutionOrderEvent | null;
};

/**
 * One modal line per strip / OCO / bullet leg. Reuses matcher
 * explainRestingOrder / blotterLifecycleEvent — does not invent a second book.
 */
export function ticketLegExecLog(input: {
  ticket: HedgeTicket;
  quote?: MarketQuote | null;
  bank?: string | null;
  tape?: string;
  incoming?: ExecutionOrderEvent | null;
}): TicketLegExecLog {
  const tape =
    input.tape ?? overlayTapeConventionLabel(input.ticket);
  const bankBit = input.bank?.trim() ? ` · ${input.bank.trim()}` : '';
  const tapeBit = ` · tape ${tape}`;
  const quote = input.quote ?? undefined;
  const incoming = input.incoming;
  if (incoming) {
    const phase: TicketLegExecPhase =
      incoming.outcome === 'blocked-policy'
        ? 'held'
        : incoming.outcome === 'rejected'
          ? 'rejected'
          : incoming.outcome === 'cancelled'
            ? 'cancelled'
            : incoming.outcome === 'filled'
              ? 'filled'
              : incoming.outcome === 'working'
                ? 'working'
                : 'live';
    return {
      orderId: incoming.orderId,
      edgeIndex: input.ticket.stripEdgeIndex ?? null,
      phase,
      summary: `${EXEC_LOG_TAG} ${incoming.summary}${tapeBit}${bankBit}`,
      atMs: incoming.atMs,
      event: incoming,
    };
  }
  if (input.ticket.status === 'cancelled') {
    const event = blotterLifecycleEvent(input.ticket, 'cancelled');
    return {
      orderId: input.ticket.id,
      edgeIndex: input.ticket.stripEdgeIndex ?? null,
      phase: 'cancelled',
      summary: `${EXEC_LOG_TAG} ${event.summary}${tapeBit}${bankBit}`,
      atMs: event.atMs,
      event,
    };
  }
  if (
    input.ticket.status === 'booked'
    || (input.ticket.filledAtMs != null && input.ticket.filledAtMs > 0)
  ) {
    const event = blotterLifecycleEvent(
      { ...input.ticket, status: 'booked' },
      'filled',
    );
    return {
      orderId: input.ticket.id,
      edgeIndex: input.ticket.stripEdgeIndex ?? null,
      phase: 'filled',
      summary: `${EXEC_LOG_TAG} ${event.summary}${tapeBit}${bankBit}`,
      atMs: event.atMs,
      event,
    };
  }
  if (input.ticket.status === 'scheduled' && input.ticket.limitRate != null) {
    const d = explainRestingOrder(input.ticket, quote, 0);
    const event = toOrderEvent(d);
    const phase: TicketLegExecPhase =
      d.outcome === 'blocked-policy'
        ? 'held'
        : d.outcome === 'filled'
          ? 'filled'
          : 'working';
    return {
      orderId: input.ticket.id,
      edgeIndex: input.ticket.stripEdgeIndex ?? null,
      phase,
      summary: `${EXEC_LOG_TAG} ${d.reason}${tapeBit}${bankBit}`,
      atMs: d.atMs,
      event,
    };
  }
  return {
    orderId: input.ticket.id,
    edgeIndex: input.ticket.stripEdgeIndex ?? null,
    phase: 'live',
    summary:
      `${EXEC_LOG_TAG} LIVE ${input.ticket.ccy} ${Math.abs(input.ticket.amountLocalM).toFixed(2)}M ${input.ticket.instrument}`
      + `${tapeBit} · bid ${fmtPx(quote?.bid ?? null)} ask ${fmtPx(quote?.ask ?? null)}`
      + ` · tiles open — not submitted${bankBit}`,
    atMs: Date.now(),
    event: null,
  };
}

/** Matcher / blotter lines that belong to this overlay's tickets. */
export function eventsForTicketModal(
  events: readonly ExecutionLogEvent[],
  tickets: readonly HedgeTicket[],
): ExecutionOrderEvent[] {
  const ids = new Set(tickets.map(t => t.id));
  const groups = new Set(
    tickets.map(t => t.ocoGroupId).filter((id): id is string => Boolean(id)),
  );
  const out: ExecutionOrderEvent[] = [];
  for (const e of events) {
    if (e.kind !== 'order') continue;
    if (ids.has(e.orderId) || (e.ocoGroupId != null && groups.has(e.ocoGroupId))) {
      out.push(e);
    }
  }
  return out;
}

/**
 * A blotter record has no market quote — it is a book entry, not a matcher
 * tick. This synthesises bid = ask = mid = the fill/limit price PURELY so
 * the notional can be converted at the executing rate. Its bid/ask are not
 * a market and must never be reported as one: printed as `marketBid` /
 * `marketAsk`, or as "vs bid 1.16250 (+0.0 pips)", it presents the fill
 * price back as the market it supposedly beat.
 */
function notionalQuoteFromTicket(ticket: HedgeTicket): MarketQuote | undefined {
  // The print on the order's own tape: a spot-referenced forward's level is
  // spot, so its replay must see the spot execution, not spot + points.
  const mid =
    tapeFillPrint(ticket)
    ?? ticket.ipaQuote?.fxSpot
    ?? ticket.limitRate;
  if (mid == null || !Number.isFinite(mid) || mid <= 0) return undefined;
  return { bid: mid, ask: mid, mid };
}

/**
 * Fields a blotter event must not carry: they would all be the synthetic
 * quote (the fill price), not observations of a market.
 */
const SYNTHETIC_QUOTE_FIELDS_CLEARED = {
  marketBid: null,
  marketAsk: null,
  marketMid: null,
  triggerPx: null,
  distancePips: null,
} as const;

function distLabel(distancePips: number | null): string {
  return distancePips != null
    ? `${distancePips >= 0 ? '+' : ''}${distancePips.toFixed(1)} pips`
    : '—';
}

/**
 * Blotter booked/cancelled is not a matcher tick — still emit the same
 * size / limit / bid / pips / notional / cap fields the desk uses to debug
 * fills. A booked ticket is explained as if it were still resting so the
 * line says WORKING vs FILLED vs BLOCKED at book time.
 */
export function blotterLifecycleEvent(
  ticket: HedgeTicket,
  outcome: 'filled' | 'cancelled' | 'rejected',
  atMs = Date.now(),
): ExecutionOrderEvent {
  const quote = notionalQuoteFromTicket(ticket);
  const clone: HedgeTicket = { ...ticket, status: 'scheduled' };
  const d = explainRestingOrder(clone, quote, 0, ticket.filledAtMs ?? atMs);
  const side = sideOf(ticket);
  const role = ticket.bracketRole ? ` ${ticket.bracketRole}` : '';
  const size = Math.abs(ticket.amountLocalM).toFixed(2);
  const blotterPx = ticket.ipaQuote?.fxOutright ?? ticket.limitRate ?? d.filledPx;
  const usd =
    d.notionalUsdM > 0
      ? d.notionalUsdM
      : quote
        ? ticketNotionalUsdM(ticket, usdPerLocalFromQuote(ticket.ccy, quote.mid))
        : 0;
  // No "vs <side> <px> (<pips>)" here: the only quote available at blotter
  // time is the synthetic one above, so that clause printed the fill price
  // as the market and a meaningless +0.0 pips of distance from itself.
  const levelTape =
    `limit ${fmtPx(ticket.limitRate ?? null)}`
    + ` · notional $${usd.toFixed(2)}M · cap $${AUTOMATED_HEDGE_LIMIT_USD_M}M`;
  const tape =
    d.reason.startsWith('WORKING')
    || d.reason.startsWith('FILLED')
    || d.reason.startsWith('BLOCKED')
      ? d.reason
      : levelTape;
  if (outcome === 'cancelled' || outcome === 'rejected') {
    const tag = outcome === 'cancelled' ? 'CANCELLED' : 'REJECTED';
    // Never embed the replayed FILLED/booked narration in a cancellation:
    // the synthetic quote is bid = ask = fill/limit price, so a cancelled
    // OCO sibling replays as "FILLED … crossed limit … booked at" — a
    // cancelled order announcing it booked, in the panel the desk uses to
    // justify fills. A cancelled line only ever carries the level facts.
    return toOrderEvent({
      ...d,
      outcome,
      filledPx: null,
      notionalUsdM: usd,
      ...SYNTHETIC_QUOTE_FIELDS_CLEARED,
      reason:
        `${tag} ${side}${role} ${ticket.ccy} ${size}M ${ticket.instrument} on ${ticket.basis}`
        + ` · ${levelTape}`,
    });
  }
  return toOrderEvent({
    ...d,
    outcome: 'filled',
    filledPx: blotterPx ?? d.filledPx,
    notionalUsdM: usd,
    ...SYNTHETIC_QUOTE_FIELDS_CLEARED,
    reason:
      `BLOTTER booked ${side}${role} ${ticket.ccy} ${size}M ${ticket.instrument} on ${ticket.basis}`
      + ` at ${fmtPx(blotterPx)} · ${tape}`,
  });
}

/** Prefer matcher FILLED/WORKING/BLOCKED with px and notional over a thin blotter line. */
export function monitorEventRichness(e: ExecutionLogEvent): number {
  if (e.kind === 'beat') return 1;
  const s = e.summary;
  let n = 0;
  if (/\b(FILLED|WORKING|BLOCKED|CANCELLED|REJECTED)\b/.test(s)) n += 80;
  if (/\bcrossed limit\b/.test(s)) n += 30;
  if (/\b(bid|ask)\b/.test(s)) n += 20;
  if (/\bpips\b/.test(s)) n += 15;
  if (/\bnotional\b/.test(s) || /\$\d/.test(s)) n += 15;
  if (/\bcap\b/.test(s) || /auto cap/.test(s)) n += 10;
  if (e.limitRate != null) n += 5;
  if (e.marketBid != null || e.marketAsk != null) n += 5;
  if (e.notionalUsdM > 0) n += 5;
  return n + Math.min(s.length, 120);
}

/**
 * Identity of the resting book this beat — outcomes and levels, not tape
 * prints. Pip distance moving is not an event.
 */
export function monitorSnapshotKey(
  decisions: readonly ExecutionDecision[],
): string {
  return decisions
    .filter(
      d =>
        d.outcome === 'working'
        || d.outcome === 'filled'
        || d.outcome === 'blocked-policy',
    )
    .map(
      d =>
        `${d.orderId}:${d.outcome}:${d.bracketRole ?? ''}:${d.limitRate ?? ''}:${d.amountLocalM}`,
    )
    .sort()
    .join('|');
}

/**
 * State transitions only: a fill, a policy block, or a change in which
 * orders are working. Idle tape prints and unchanged heartbeats emit nothing.
 */
export function eventsForBeat(
  decisions: readonly ExecutionDecision[],
  elapsedMs: number,
  ccyCount: number,
  _heartbeat: boolean,
  atMs = Date.now(),
  previousSnapshotKey = '',
): ExecutionLogEvent[] {
  const key = monitorSnapshotKey(decisions);
  if (key === previousSnapshotKey) return [];
  const notable = decisions.filter(
    d => d.outcome === 'filled' || d.outcome === 'blocked-policy',
  );
  const out: ExecutionLogEvent[] = [];
  if (notable.length > 0) {
    out.push(beatEvent(decisions, elapsedMs, ccyCount, atMs));
  }
  const prevIds = new Set(
    previousSnapshotKey
      .split('|')
      .filter(Boolean)
      .map(part => part.split(':')[0] ?? ''),
  );
  for (const d of decisions) {
    if (d.outcome === 'filled' || d.outcome === 'blocked-policy') {
      const wasSame =
        previousSnapshotKey
          .split('|')
          .some(part => part.startsWith(`${d.orderId}:${d.outcome}:`));
      if (!wasSame) out.push(toOrderEvent(d));
    } else if (d.outcome === 'working' && !prevIds.has(d.orderId)) {
      out.push(toOrderEvent(d));
    }
  }
  return out;
}

/** Journal leftovers from the blotter stub: "Sell GBP take profit booked". */
export function isThinBlotterMonitorStub(e: ExecutionLogEvent): boolean {
  if (e.kind !== 'order') return false;
  const s = e.summary.trim();
  if (/\b(FILLED|WORKING|BLOCKED|CANCELLED|REJECTED|limit|notional|pips)\b/.test(s)) {
    return false;
  }
  return /take profit booked$|stop loss booked$| order booked$/i.test(s);
}

/** Newest-first: keep one fill/block per order and drop idle beats. */
export function dedupeMonitorEvents(
  events: readonly ExecutionLogEvent[],
): ExecutionLogEvent[] {
  const seen = new Map<string, number>();
  const out: ExecutionLogEvent[] = [];
  for (const e of events) {
    if (e.kind === 'order' && isThinBlotterMonitorStub(e)) continue;
    if (e.kind === 'beat') {
      if (e.triggered === 0) continue;
      const id = `beat:${e.atMs}:${e.summary}`;
      if (seen.has(id)) continue;
      seen.set(id, out.length);
      out.push(e);
      continue;
    }
    const id =
      e.outcome === 'filled' || e.outcome === 'blocked-policy'
        ? `${e.outcome}:${e.orderId}`
        : `${e.outcome}:${e.orderId}:${e.limitRate}:${e.bracketRole ?? ''}:${e.amountLocalM}`;
    const idx = seen.get(id);
    if (idx == null) {
      seen.set(id, out.length);
      out.push(e);
      continue;
    }
    if (monitorEventRichness(e) > monitorEventRichness(out[idx]!)) {
      out[idx] = e;
    }
  }
  return out;
}
