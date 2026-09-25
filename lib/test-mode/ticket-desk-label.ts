import { swapPointsToPriceDelta } from '@/lib/fx-market-rates';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import {
  settleMonthsFromHedgeTicket,
  spotReferencedFillQuote,
} from '@/lib/test-mode/hedge-var';
import { tapeFillPrint } from '@/lib/test-mode/tape-candles';

export type HitSide = 'bid' | 'ask';

export function addWeekdays(start: Date, n: number): Date {
  const d = new Date(start);
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d;
}

export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Settle date for a tenor: spot is T+2, a forward is T+2 after the tenor. */
export function settleDateFromMonths(
  instrument: HedgeTicket['instrument'],
  months: number,
  from: Date = new Date(),
): Date {
  if (instrument === 'spot' || !(months > 0)) return addWeekdays(from, 2);
  const fwd = new Date(from);
  const whole = Math.floor(months);
  const frac = months - whole;
  fwd.setMonth(fwd.getMonth() + whole);
  if (frac > 0) fwd.setDate(fwd.getDate() + Math.round(frac * 30.4375));
  return addWeekdays(fwd, 2);
}

/** Trade date — the fill. Absent while an order is still working. */
export function ticketTradeDateIso(t: HedgeTicket): string | null {
  if (t.filledAtMs != null && Number.isFinite(t.filledAtMs)) {
    return toIsoDate(new Date(t.filledAtMs));
  }
  return null;
}

/**
 * Value date. Counted from the fill once traded, else from today — an
 * unfilled order's settle date is indicative and moves with the trade date.
 */
export function ticketValueDateIso(t: HedgeTicket): string {
  const from =
    t.filledAtMs != null && Number.isFinite(t.filledAtMs)
      ? new Date(t.filledAtMs)
      : new Date();
  return toIsoDate(
    settleDateFromMonths(t.instrument, settleMonthsFromHedgeTicket(t), from),
  );
}

/** Hedge convention: selling FCY cover is a positive amountLocalM. */
export function ticketTradeSide(
  t: Pick<HedgeTicket, 'orderSide' | 'amountLocalM'>,
): 'Buy' | 'Sell' {
  return t.orderSide ?? (t.amountLocalM >= 0 ? 'Sell' : 'Buy');
}

/**
 * Limit-ticket pad that encodes Buy/Sell (bid→Buy, ask→Sell).
 * A stop-loss rests on the opposite pad; never treat the SL pad as this.
 */
export function limitTakeProfitHit(side: 'Buy' | 'Sell'): HitSide {
  return side === 'Buy' ? 'bid' : 'ask';
}

/**
 * Placement instant encoded in a ticket id (`ht-<ms base36>-<rand>`, see
 * newHedgeTicketId). The booking chart's story starts here. Null for ids
 * from other schemes or an implausible decode.
 */
export function ticketPlacedAtMs(id: string | null | undefined): number | null {
  if (!id) return null;
  const m = /^ht-([a-z0-9]+)-/i.exec(id);
  if (!m) return null;
  const ms = parseInt(m[1]!, 36);
  // Sanity band: 2001-09 … 2096-10 — rejects rands and truncated ids.
  return Number.isFinite(ms) && ms > 1e12 && ms < 4e12 ? ms : null;
}

/** How much tape the booking chart keeps past the execution instant. */
export const POST_FILL_TAPE_TAIL_MS = 180_000;

/** Desk quote panel — no live RFQ; JPM is the NP / curve source. */
const DESK_BANKS = ['JPM', 'Citi', 'HSBC', 'Barclays'] as const;

/** Simulated dealer rotation for a leg's quote panel — bid side at `index`,
 * ask side at `index + 1` (matches the ticket tile's bankBid/bankAsk). */
export function bankForLeg(ccy: string, index: number): string {
  const rot = Math.abs(ccy.charCodeAt(0) + index) % DESK_BANKS.length;
  return DESK_BANKS[rot]!;
}

/**
 * Dealer to RECORD on a ticket at fill time, so the blotter and the fill
 * footer name the same bank instead of the footer re-inventing one from a
 * pad each render (review finding 11). Same rotation the tiles display,
 * taken on the EXECUTED side.
 */
export function fillCounterpartyFor(t: {
  ccy: string;
  stripEdgeIndex?: number;
  counterparty?: string;
  executedHit: HitSide;
}): string {
  if (t.counterparty) return t.counterparty;
  const edge = t.stripEdgeIndex ?? 0;
  return bankForLeg(t.ccy, edge + (t.executedHit === 'ask' ? 1 : 0));
}

export type TapeLevelRole = 'TP' | 'SL' | 'LIMIT';

export type TapeOrderLevel = {
  price: number;
  role: TapeLevelRole;
  /**
   * True when `price` is the frozen execution print (not the resting limit).
   * Chart paints filled TP/SL yellow and must not rebind this to live tape.
   */
  filled?: boolean;
  /**
   * True when the order behind `price` was auto-cancelled — an OCO sibling
   * whose other leg filled. It never executed, so it is never `filled`, but
   * the desk still wants to see where it was resting. Chart paints it grey,
   * and must not test it against the live tape for a HIT.
   */
  cancelled?: boolean;
  /**
   * True when `price` is a level the desk has TYPED but not yet submitted.
   * No order exists behind it, so it can never be hit or filled — the chart
   * marks it PENDING so a line being composed is never read as one already
   * working in the market.
   */
  preview?: boolean;
  /**
   * Set only when `price` was converted from a spot-referenced order's spot
   * limit to the leg's forward — carries the spot level the order actually
   * rests at, so a caller can still identify the order behind the line.
   */
  spotLimitRate?: number;
};

type TapeLevelTicket = Pick<HedgeTicket, 'limitRate' | 'bracketRole'> &
  Partial<
    Pick<
      HedgeTicket,
      | 'id'
      | 'status'
      | 'filledAtMs'
      | 'ipaQuote'
      | 'ccy'
      | 'isSpotReferenced'
      | 'stripLegPoints'
    >
  >;

/**
 * Price distance of the leg points a spot-referenced order was left for —
 * null for every other ticket. Pair-scaled, so JPY points divide by 100.
 */
export function spotReferencedLegShift(
  t: Pick<HedgeTicket, 'ccy' | 'isSpotReferenced' | 'stripLegPoints'>,
): number | null {
  if (!t.isSpotReferenced) return null;
  const points = t.stripLegPoints;
  if (points == null || !Number.isFinite(points) || points === 0) return null;
  return swapPointsToPriceDelta(points, t.ccy);
}

/**
 * The mid the desk saw when it left the order, in the convention its chart
 * is drawn in. A spot-referenced order rests on spot while its chart is the
 * leg's forward, so its anchor moves by the leg's points — as its limit
 * does. Left at spot, a short-tenor pin sat inside the 40-pip continuity
 * band and was drawn 28 pips under a forward series, and the opening candle
 * was widened down to it.
 */
export function placementAnchorRate(
  t: Pick<
    HedgeTicket,
    'ccy' | 'isSpotReferenced' | 'stripLegPoints' | 'restingAnchorRate' | 'limitRate'
  > &
    // Optional because the function answers without them: a ticket with no
    // stamps keeps its anchor as stored.
    Partial<Pick<HedgeTicket, 'instrument' | 'ipaQuote'>>,
): number | null {
  const anchor = t.restingAnchorRate ?? t.limitRate ?? null;
  if (anchor == null || !Number.isFinite(anchor) || anchor <= 0) return null;
  const referenced = spotReferencedLegShift(t);
  if (referenced != null) return anchor + referenced;
  // A plain FORWARD-TILE order is the other way round: no isSpotReferenced
  // flag and no stripLegPoints, yet it still stores its level as the
  // outright and its anchor as the SPOT mid. On one real EUR leg the anchor
  // was 1.14174 against a stamped spot of 1.14164 — one pip — while its own
  // outright was 1.14417, a 25.3-pip points width away. Pinned raw, the
  // marker sat 25 pips below a forward chart's candles and
  // `widenCandlesToFills` stretched a bar down to reach it, drawing a wick no
  // market printed. The 40-pip continuity guard cannot catch this: a points
  // width is smaller than the spot-vs-outright jump that guard exists for.
  if ((t.instrument ?? 'spot') === 'spot') return anchor;
  const spot = t.ipaQuote?.fxSpot;
  const outright = t.ipaQuote?.fxOutright;
  if (spot == null || !(spot > 0) || outright == null || !(outright > 0)) {
    return anchor;
  }
  // Shift only an anchor that is demonstrably a spot mid; one already stored
  // in the chart's own convention is returned untouched.
  return Math.abs(anchor - spot) <= Math.abs(anchor - outright)
    ? anchor + (outright - spot)
    : anchor;
}

/**
 * A resting spot-referenced order's limit expressed at the leg's forward.
 * Null when it cannot be converted, so the caller keeps the spot level.
 */
function forwardOfSpotLimit(t: TapeLevelTicket): number | null {
  const limit = t.limitRate;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return null;
  if (t.ccy == null) return null;
  return (
    spotReferencedFillQuote(
      {
        ccy: t.ccy,
        isSpotReferenced: t.isSpotReferenced,
        stripLegPoints: t.stripLegPoints,
      },
      limit,
    )?.fxOutright ?? null
  );
}

/**
 * Where a FILLED spot-referenced order's line belongs on a forward leg's
 * chart: the forward it booked, not the spot print it executed on. Null
 * until it fills — `fxOutright` carries the resting limit before that.
 */
function bookedForwardFill(t: TapeLevelTicket): number | null {
  const print = executionFillRate(t);
  if (print == null) return null;
  const booked = t.ipaQuote?.fxOutright;
  if (booked != null && Number.isFinite(booked) && booked > 0) return booked;
  if (t.ccy == null) return print;
  return (
    spotReferencedFillQuote(
      {
        ccy: t.ccy,
        isSpotReferenced: t.isSpotReferenced,
        stripLegPoints: t.stripLegPoints,
      },
      print,
    )?.fxOutright ?? print
  );
}

/**
 * Sticky execution rate for a booked fill — `ipaQuote.fxOutright` stamped at
 * fill time, else the resting limit. Null while the order is still working.
 * Callers that must survive later quote churn should lock the first non-null
 * value they see (see TradeTicketPanel stickyFills).
 */
export function executionFillRate(
  t: Pick<HedgeTicket, 'status' | 'filledAtMs' | 'ipaQuote' | 'limitRate' | 'isSpotReferenced'>,
): number | null {
  const filledAt = t.filledAtMs;
  const booked =
    t.status === 'booked'
    && filledAt != null
    && Number.isFinite(filledAt)
    && filledAt > 0;
  if (!booked) return null;
  // On the tape it traded on: a spot-referenced forward's print is its spot
  // execution, not the booked spot + points.
  const print = tapeFillPrint(t);
  if (print != null && Number.isFinite(print) && print > 0) return print;
  if (t.limitRate != null && Number.isFinite(t.limitRate) && t.limitRate > 0) {
    return t.limitRate;
  }
  return null;
}

function tapeRoleFor(
  t: Pick<HedgeTicket, 'bracketRole'>,
): TapeLevelRole {
  if (t.bracketRole === 'takeProfit') return 'TP';
  if (t.bracketRole === 'stopLoss') return 'SL';
  return 'LIMIT';
}

/**
 * Price lines for the ticket tape chart.
 *
 * A resting order's own `bracketRole` is the only authority on what its level
 * IS, so placed orders always win. The typed preview names its two lines by
 * pad convention instead, and while that ran first a placed STOP was drawn as
 * a "TP" line at the level it went on to fill at — the fill marker said SL and
 * the price line said TP for one order. Every other role label in the app
 * (`ticketRoleLabel`, the fill marker, verify-strip-legs) reads `bracketRole`;
 * this is the one that did not.
 *
 * Once a leg is booked, the line uses the sticky execution print (not the
 * resting limit, and never a live pad / Brownian walk). `stickyFills` (ticket
 * id → rate) wins so later quote churn cannot move a filled TP/SL.
 *
 * `side` must be the flip-aware ticket side, not the armed pad — those
 * disagree on a flipped pair, which swapped the two preview labels.
 */
export function tapeOrderLevels(input: {
  placed: readonly TapeLevelTicket[];
  side: 'Buy' | 'Sell';
  previewRates?: Record<HitSide, string> | null;
  /** First-seen execution prints keyed by ticket id — freeze after fill. */
  stickyFills?: Readonly<Record<string, number>>;
  /**
   * False when the chart draws a forward leg. A spot-referenced order fills
   * on a spot print; on that chart its line belongs at the forward it
   * booked — the convention the fill pin already uses.
   */
  chartIsSpot?: boolean;
  /**
   * Price delta added to each preview level. The pad's typed levels are
   * spot (the strip's brackets are spot-referenced); on a forward leg's chart
   * they are drawn at spot plus that leg's points, like a resting order is.
   */
  previewShift?: number;
}): TapeOrderLevel[] {
  const seen = new Set<number>();
  const placed: TapeOrderLevel[] = [];
  for (const t of input.placed) {
    const onLegChart = input.chartIsSpot === false && t.isSpotReferenced === true;
    const sticky =
      !onLegChart && t.id != null && t.id !== ''
        ? input.stickyFills?.[t.id]
        : undefined;
    const fill = onLegChart
      ? bookedForwardFill(t)
      : sticky != null && Number.isFinite(sticky) && sticky > 0
        ? sticky
        : executionFillRate(t);
    // A resting spot-referenced order rests at a spot level. On the leg's own
    // chart that level is a whole points-shift off every candle, so draw it at
    // the leg's forward and keep the spot level alongside.
    const restingAtForward =
      onLegChart && fill == null ? forwardOfSpotLimit(t) : null;
    const price = fill ?? restingAtForward ?? t.limitRate;
    if (price == null || !Number.isFinite(price) || price <= 0) continue;
    if (seen.has(price)) continue;
    seen.add(price);
    placed.push({
      price,
      role: tapeRoleFor(t),
      ...(fill != null ? { filled: true as const } : {}),
      // A cancelled ticket never executes, so `fill` above is always null for
      // it — no conflict with `filled`.
      ...(t.status === 'cancelled' ? { cancelled: true as const } : {}),
      ...(restingAtForward != null && t.limitRate != null
        ? { spotLimitRate: t.limitRate }
        : {}),
    });
  }
  // Once a real order is LIVE — resting or filled — the chart shows orders,
  // not intentions: `previewRates` carries whatever the pad currently holds,
  // which is a market-derived default until the desk edits it, so merging it
  // next to a working order paints a level nobody asked for.
  //
  // A CANCELLED level is not a live order. This used to bail the moment ANY
  // level existed, cancelled included, and a cancelled sibling is precisely
  // what sits beside the order being composed: with a cancelled stop on the
  // chart, an OCO being typed next to it drew no line at all for the level
  // about to be submitted. Cancelled levels stay, and the preview still runs.
  if (placed.some(level => !level.cancelled)) return placed;
  if (!input.previewRates) return placed;
  const takeProfitHit = limitTakeProfitHit(input.side);
  const stopLossHit: HitSide = takeProfitHit === 'bid' ? 'ask' : 'bid';
  const shift = input.previewShift ?? 0;
  const preview = (raw: string): number => {
    const typed = Number(raw);
    return Number.isFinite(typed) && typed > 0 ? typed + shift : Number.NaN;
  };
  const previews: TapeOrderLevel[] = [
    { price: preview(input.previewRates[takeProfitHit]), role: 'TP' as const },
    { price: preview(input.previewRates[stopLossHit]), role: 'SL' as const },
  ]
    // A preview on a price a cancelled level already drew would be a second
    // line on the same pixel — the cancelled one carries the history, so it
    // keeps the spot.
    .filter(
      level =>
        Number.isFinite(level.price) && level.price > 0 && !seen.has(level.price),
    )
    .map(level => ({ ...level, preview: true as const }));
  return [...placed, ...previews];
}

export function ticketRoleLabel(t: HedgeTicket): string {
  if (t.bracketRole === 'takeProfit' || t.orderType === 'takeProfit') {
    return 'TAKE PROFIT';
  }
  if (t.bracketRole === 'stopLoss' || t.orderType === 'stopLoss') {
    return 'STOP LOSS';
  }
  if (t.orderType === 'oco' || t.ocoGroupId) return 'OCO';
  // A resting level is what makes an order a LIMIT. Without one it is a
  // market order, whatever its status — the previous rule also demanded
  // `status === 'booked'`, so a ticket filled before anything stamped a
  // status (a Decision Book compose starts with none) matched nothing and
  // fell through to the catch-all below. That printed a market buy-back as
  // "LIMIT · BUY EUR · €0.02M" on the blotter.
  if (t.limitRate == null || t.orderType === 'market') return 'MARKET';
  return 'LIMIT';
}

/**
 * Compact order-type chip for dense strip / pad fill chrome.
 * Aligns with HitPad fill roles (TP / SL / LIMIT) and adds MKT for click-trade
 * / HitPad market prints so executed strip tiles show what kind of order filled.
 */
export type TicketOrderTypeChip = 'MKT' | 'LIMIT' | 'TP' | 'SL' | 'OCO';

export function ticketOrderTypeChip(t: HedgeTicket): TicketOrderTypeChip {
  switch (ticketRoleLabel(t)) {
    case 'TAKE PROFIT':
      return 'TP';
    case 'STOP LOSS':
      return 'SL';
    case 'MARKET':
      return 'MKT';
    case 'OCO':
      return 'OCO';
    default:
      return 'LIMIT';
  }
}

export function unsignedLocalM(ccy: string, amountLocalM: number): string {
  const abs = Math.abs(amountLocalM).toFixed(2);
  if (ccy === 'EUR') return `€${abs}M`;
  if (ccy === 'PLN') return `zł${abs}M`;
  if (ccy === 'GBP') return `£${abs}M`;
  return `${abs}M ${ccy}`;
}

/** Buy is unsigned; Sell is −amount. Matches Decision blotter copy. */
export function signedTradeLocal(
  ccy: string,
  amountLocalM: number,
  side: 'Buy' | 'Sell',
): string {
  const mag = unsignedLocalM(ccy, amountLocalM);
  return side === 'Sell' ? `−${mag}` : mag;
}

/** TAKE PROFIT · BUY GBP · £5.08M */
export function ticketBlotterLabel(t: HedgeTicket): string {
  const side = ticketTradeSide(t);
  return `${ticketRoleLabel(t)} · ${side.toUpperCase()} ${t.ccy} · ${signedTradeLocal(t.ccy, t.amountLocalM, side)}`;
}

export function ticketFillWorkingLabel(t: HedgeTicket): string {
  const qty = signedTradeLocal(t.ccy, t.amountLocalM, ticketTradeSide(t));
  // A cancelled order is neither filled nor working. Zeroing the amounts was
  // half the fix: the word "working" stayed in the string, so a CANCELED strip
  // leg still read "… / 0.00M working" — and because the cell does not wrap on
  // a nowrap, that tail landed on its own line and looked like a second,
  // contradicting status. A dead order names its state instead of counting.
  if (t.status === 'cancelled') {
    return '0.00M filled · cancelled';
  }
  if (t.status === 'scheduled') {
    return `0.00M filled / ${qty} working`;
  }
  return `${qty} filled / 0.00M working`;
}

export type OrderValidity = 'DAY' | 'GTC';

const FX_DAY_TZ = 'America/New_York';
const FX_DAY_CLOSE_HOUR = 17;

function zoneParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const got = Object.fromEntries(
    parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]),
  );
  return {
    year: Number(got.year),
    month: Number(got.month),
    day: Number(got.day),
    hour: Number(got.hour),
    minute: Number(got.minute),
  };
}

/** Convert a wall-clock time in `timeZone` to epoch ms. */
function wallInZoneToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const shown = zoneParts(utcGuess, timeZone);
  const shownAsUtc = Date.UTC(
    shown.year,
    shown.month - 1,
    shown.day,
    shown.hour,
    shown.minute,
  );
  return utcGuess - (shownAsUtc - utcGuess);
}

/** FX DAY orders expire at 17:00 America/New_York (next close if already past). */
export function nextFxDayCloseMs(nowMs = Date.now()): number {
  const ny = zoneParts(nowMs, FX_DAY_TZ);
  const closeToday = wallInZoneToUtcMs(
    ny.year,
    ny.month,
    ny.day,
    FX_DAY_CLOSE_HOUR,
    0,
    FX_DAY_TZ,
  );
  if (nowMs < closeToday) return closeToday;
  const next = new Date(Date.UTC(ny.year, ny.month - 1, ny.day + 1));
  return wallInZoneToUtcMs(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    FX_DAY_CLOSE_HOUR,
    0,
    FX_DAY_TZ,
  );
}

export function goodTillMsForValidity(
  validity: OrderValidity,
  nowMs = Date.now(),
): number | undefined {
  if (validity !== 'DAY') return undefined;
  return nextFxDayCloseMs(nowMs);
}

export function formatLimitPx(px: number): string {
  if (!Number.isFinite(px) || px <= 0) return '—';
  if (px >= 20) return px.toFixed(3);
  return px.toFixed(5);
}

/** Limit column: `@ 1.34689` */
export function ticketLimitLevelLabel(
  t: Pick<HedgeTicket, 'limitRate' | 'status' | 'ipaQuote' | 'isSpotReferenced'>,
): string {
  const fill = t.ipaQuote?.fxOutright;
  if (
    t.status === 'booked'
    && fill != null
    && Number.isFinite(fill)
    && fill > 0
  ) {
    return `@ ${formatLimitPx(fill)}`;
  }
  if (t.limitRate == null || !(t.limitRate > 0)) return '—';
  // A spot-referenced forward rests at a SPOT level — say so on its FWD row.
  return `@ ${formatLimitPx(t.limitRate)}${t.isSpotReferenced ? ' spot' : ''}`;
}

export function formatGoodTillMs(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: FX_DAY_TZ,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(ms))
    .replace(',', '');
}

/** GTC, or `GTD 4 Sep 17:00` for a DAY order. */
export function ticketGoodTillLabel(
  t: Pick<HedgeTicket, 'orderValidity' | 'goodTillMs' | 'limitRate'>,
): string {
  if (t.limitRate == null) return '—';
  if (t.goodTillMs != null && Number.isFinite(t.goodTillMs)) {
    return `GTD ${formatGoodTillMs(t.goodTillMs)}`;
  }
  if (t.orderValidity === 'DAY') return 'DAY';
  return 'GTC';
}
