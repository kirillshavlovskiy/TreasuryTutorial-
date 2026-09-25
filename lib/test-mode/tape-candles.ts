import type { UTCTimestamp } from 'lightweight-charts';

/** Closed/forming OHLC bar length on the live tape (zoomed in). */
export const TAPE_BAR_SEC = 5;

export type TapeBarSec = 5 | 15 | 30 | 60 | 300 | 900 | 3600;

export const TAPE_BAR_OPTIONS: readonly TapeBarSec[] = [
  5, 15, 30, 60, 300, 900, 3600,
];

/** Keep ~6h of 1s prints so zoom-out can show hours, not minutes. */
export const TAPE_TRAIL_MAX_POINTS = 6 * 3600;

/** Live tape the desk keeps per key in the browser — TAPE_TRAIL_MAX_POINTS at the tape's 1s beat. */
export const TAPE_HISTORY_KEEP_MS = 6 * 3600 * 1000;

/**
 * Evict live points older than the keep window. Rows marked `recorded` — the
 * backstop's read of an open booking's story — stay however old the booking
 * is. The count cap this replaces evicted the OLDEST points first, and a
 * two-day-old story's rows are exactly those: an hour of live tape pushed
 * them out, the panel reseeded from today's ticks, clipped them to a window
 * two days back, and the chart of a booking that had just drawn went blank.
 */
export function capTapeHistory<T extends { t: number; recorded?: boolean }>(
  points: T[],
  nowMs: number,
): T[] {
  const cutoff = nowMs - TAPE_HISTORY_KEEP_MS;
  const kept = points.filter(p => p.recorded === true || p.t >= cutoff);
  return kept.length === points.length ? points : kept;
}

/** Aim for this many candles in the visible window. */
const TARGET_VISIBLE_BARS = 80;
const SWITCH_UP_BARS = 130;
const SWITCH_DOWN_BARS = 40;

/**
 * Pick an OHLC length so a visible time span stays around ~80 bars.
 * Zoomed in stays on 5s; hours of tape step up to 1m / 5m / 15m.
 */
export function pickTapeBarSec(spanSec: number): TapeBarSec {
  if (!(spanSec > 0) || !Number.isFinite(spanSec)) return TAPE_BAR_SEC;
  const raw = spanSec / TARGET_VISIBLE_BARS;
  if (raw <= 10) return 5;
  if (raw <= 22) return 15;
  if (raw <= 45) return 30;
  if (raw <= 180) return 60;
  if (raw <= 600) return 300;
  if (raw <= 1800) return 900;
  return 3600;
}

/** Avoid flicker at the boundary when the user is still scrolling. */
export function stabilizeTapeBarSec(
  current: TapeBarSec,
  spanSec: number,
): TapeBarSec {
  const next = pickTapeBarSec(spanSec);
  if (next === current) return current;
  const bars = spanSec / current;
  if (next > current && bars >= SWITCH_UP_BARS) return next;
  if (next < current && bars <= SWITCH_DOWN_BARS) return next;
  return current;
}

export function tapeBarLabel(barSec: TapeBarSec): string {
  if (barSec < 60) return `${barSec}s`;
  if (barSec < 3600) return `${barSec / 60}m`;
  return `${barSec / 3600}h`;
}

/** Wall-clock prints that get bucketed into `TAPE_BAR_SEC` candles. */
export type TapeTick = {
  bid: number;
  ask: number;
  mid: number;
  /** Unix ms (preferred) or unix seconds. */
  t: number;
};

export type TapeCandle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
};

/** Spot vs 1Y outright is ~170 EUR pips — never a real 5s print. */
export const TAPE_MAX_JUMP_PIPS = 40;

/**
 * How far outside its own bar a fill may sit and still widen it. Covers a
 * print on one side of the book against a mid bar; anything beyond is a
 * different convention or a different leg — see `widenCandlesToFills`.
 */
export const TAPE_FILL_WIDEN_MAX_PIPS = 5;

function pipSizeForTape(px: number): number {
  return px >= 20 ? 0.01 : 0.0001;
}

export function tapeJumpPips(fromMid: number, toMid: number): number {
  if (!(fromMid > 0) || !(toMid > 0)) return Infinity;
  return Math.abs(toMid - fromMid) / pipSizeForTape(Math.max(fromMid, toMid));
}

export function isTapeContinuityBreak(
  fromMid: number,
  toMid: number,
  maxPips = TAPE_MAX_JUMP_PIPS,
): boolean {
  return tapeJumpPips(fromMid, toMid) > maxPips;
}

/**
 * Longest silence across which two prints are still "consecutive". A
 * convention switch replaces the series from one print to the next, so it
 * shows up between prints a beat apart; past this the tape simply stopped.
 */
export const TAPE_CONVENTION_BREAK_MAX_GAP_MS = 10_000;

/**
 * Keep ticks after the last convention jump (spot series vs forward outright)
 * so a candle cannot open at 1.15 and close at 1.17 on the same bar.
 *
 * A price jump is only evidence of a convention change when the two prints
 * are ADJACENT IN TIME. The recorder drops ticks — it stalls on store I/O and
 * stops entirely while nothing references a currency — and across a gap of
 * minutes the market moves further than `maxPips` as a matter of course. Read
 * as a convention break, every such gap truncated the series to whatever came
 * after the last one: a chart holding hours of recorded tape drew only the
 * stretch since the most recent outage and the desk was told, wrongly, that
 * nothing older had been saved. Recording gaps are a hole in the series, not
 * a new series — the pieces either side belong to the same tape and are kept.
 */
export function dropTapeConventionBreak<T extends { mid: number; t?: number }>(
  ticks: readonly T[],
  maxPips = TAPE_MAX_JUMP_PIPS,
): T[] {
  if (ticks.length === 0) return [];

  // Cut wherever consecutive prints disagree. Every jump opens a segment,
  // including one across a recording gap: contamination has been observed
  // starting immediately after a 14-minute outage, and a boundary that is
  // not drawn there lets the bad prints ride inside a good segment and
  // carry the whole main line off with them.
  const bounds = [0];
  for (let i = 1; i < ticks.length; i++) {
    if (isTapeContinuityBreak(ticks[i - 1]!.mid, ticks[i]!.mid, maxPips)) {
      bounds.push(i);
    }
  }
  if (bounds.length === 1) return ticks.slice() as T[];

  const segments = bounds.map((from, k) =>
    ticks.slice(from, bounds[k + 1] ?? ticks.length),
  );
  const gapAtBound = (k: number): number | null => {
    const prev = ticks[bounds[k]! - 1];
    const cur = ticks[bounds[k]!];
    if (!prev || !cur || prev.t == null || cur.t == null) return null;
    return tickTimeMs(cur.t) - tickTimeMs(prev.t);
  };

  // What separates the two things a jump can mean is whether the tape COMES
  // BACK. A convention change is permanent — spot never returns once the key
  // switches to outrights. Contamination is a visit: a writer put a forward
  // leg's outright on the shared spot key for as long as that leg was
  // watched, then the live feed resumed and the level returned to where it
  // left. Cutting at the last jump treated every visit as a change and threw
  // away everything before it — on one EUR session, 13,904 of 17,862 genuine
  // spot prints, so a chart holding since 10:31 opened at 15:16.
  let kept = segments[0]!.slice();
  let mainMid = kept[kept.length - 1]!.mid;
  for (let k = 1; k < segments.length; k++) {
    const segment = segments[k]!;
    if (!isTapeContinuityBreak(mainMid, segment[0]!.mid, maxPips)) {
      kept.push(...segment);
      mainMid = segment[segment.length - 1]!.mid;
      continue;
    }
    const returns = segments
      .slice(k + 1)
      .some(later => !isTapeContinuityBreak(mainMid, later[0]!.mid, maxPips));
    if (returns) continue; // an excursion — drop it, the main line resumes
    const gapMs = gapAtBound(k);
    if (gapMs != null && gapMs > TAPE_CONVENTION_BREAK_MAX_GAP_MS) {
      // Nothing was recorded across this jump, so it is the market moving
      // while the tape was down — one series with a hole, not a new one.
      kept.push(...segment);
      mainMid = segment[segment.length - 1]!.mid;
      continue;
    }
    kept = segment.slice(); // a real convention change: the old series goes
    mainMid = kept[kept.length - 1]!.mid;
  }
  return kept as T[];
}


/**
 * Mid the matcher / tape must walk: same convention as `limitRate` (outright
 * for a forward), never a spot print 170 points away from the order.
 */
export function restingTapeAnchorMid(ticket: {
  limitRate?: number | null;
  restingAnchorRate?: number | null;
  ipaQuote?: { fxOutright?: number | null; fxSpot?: number | null } | null;
}): number | null {
  const limit = ticket.limitRate;
  const rest = ticket.restingAnchorRate;
  const outright = ticket.ipaQuote?.fxOutright;
  const nearLimit = (px: number | null | undefined) =>
    limit != null
    && limit > 0
    && px != null
    && px > 0
    && !isTapeContinuityBreak(limit, px);

  if (nearLimit(outright)) return outright as number;
  if (nearLimit(rest)) return rest as number;
  if (
    limit != null
    && limit > 0
    && rest != null
    && rest > 0
    && isTapeContinuityBreak(limit, rest)
  ) {
    return limit;
  }
  if (rest != null && rest > 0) return rest;
  if (limit != null && limit > 0) return limit;
  return null;
}

/**
 * Where to pin the "order placed" marker on a leg's own tape: the mid the
 * desk was looking at when the order was left (`restingAnchorRate`), at the
 * first recorded print at or after the placement instant (`placedAtMs`,
 * decoded from the ticket id). The trail now keeps recorded context from
 * before the order was left, so its first point is no longer the placement
 * — without the instant the pin would slide back to the record's start.
 * Falls back to the trail's first point when no instant is known or no
 * print sits after it, and to the trail's opening mid when the order carries
 * no anchor, or when the anchor sits a convention break away from the trail
 * (i.e. this trail is the wrong tape for the order) so the pin stays on chart.
 */
export function placementMarkFromTrail(
  ticket: { restingAnchorRate?: number | null },
  trail: readonly { mid: number; t: number }[],
  placedAtMs?: number | null,
): { t: number; px: number } | null {
  const recorded = trail.filter(point => point.mid > 0 && point.t > 0);
  const first =
    (placedAtMs != null && placedAtMs > 0
      ? recorded.find(point => point.t >= placedAtMs)
      : undefined)
    ?? recorded[0];
  if (!first) return null;
  const anchor = ticket.restingAnchorRate;
  const px =
    anchor != null && anchor > 0 && !isTapeContinuityBreak(anchor, first.mid)
      ? anchor
      : first.mid;
  return { t: first.t, px };
}

/**
 * Mid to walk so a stop is not already through on the first parked print.
 * `quoteFromMid(limit)` sets bid = limit − 1 pip, which fills a sell stop.
 */
export function parkMidAwayFromStopLimit(
  mid: number,
  limit: number,
  hitBid: boolean,
): number {
  if (!(mid > 0) || !(limit > 0)) return mid;
  const pip = pipSizeForTape(mid);
  if (hitBid) {
    if (mid - pip > limit) return mid;
    return limit + 8 * pip;
  }
  if (mid + pip < limit) return mid;
  return limit - 8 * pip;
}

export type OrderTapeTicket = {
  instrument?: string | null;
  isSpotReferenced?: boolean;
  limitRate?: number | null;
  restingAnchorRate?: number | null;
  ipaQuote?: { fxOutright?: number | null; fxSpot?: number | null } | null;
};

/**
 * Keep the ticket overlay mounted across Book → leave/fill. A new `book:`
 * id remounts on open; confirm must not swap it for `tape:<newId>`.
 */
export function retainTicketOverlayKey(
  prev: string | null | undefined,
  nextId: string,
  kind: 'keep' | 'book' | 'view' | 'edit',
): string {
  if (kind === 'book') return `book:${nextId}`;
  if (kind === 'edit') return `tape:${nextId}:edit`;
  if (kind === 'view') return `tape:${nextId}`;
  if (prev != null && prev.length > 0) {
    if (prev.startsWith('book:')) return prev;
    if (prev.includes(':edit')) return `tape:${nextId}`;
    return prev;
  }
  return `tape:${nextId}`;
}

/**
 * Live pad / candle quote on the order's tape — never mix spot onto a
 * forward. Same formula (the fresh live-priced outright) whether the order
 * is still being drafted or has already filled and is being reopened later:
 * the guard below distrusts `priced` only when it looks like spot was
 * substituted for the outright (its mid sits on the spot tape, not the
 * forward's), never merely because time has passed since the order's own
 * stored anchor was set — an aged/executed forward's anchor is expected to
 * drift from today's live price as the market moves, and that drift alone
 * is not a convention mixup.
 */
export function liveTapeQuoteForOrder(
  ticket: OrderTapeTicket,
  priced: { bid: number | null; ask: number | null } | null | undefined,
  spotFallback?: { bid: number; ask: number; mid: number } | null,
): { bid: number; ask: number; mid: number } | null {
  const pricedBid = priced?.bid;
  const pricedAsk = priced?.ask;
  const pricedMid =
    pricedBid != null && pricedAsk != null && pricedBid > 0 && pricedAsk > 0
      ? (pricedBid + pricedAsk) / 2
      : null;
  const orderMid = restingTapeAnchorMid(ticket);
  const isSpot = tapeInstrument(ticket) === 'spot';

  if (pricedMid != null && pricedBid != null && pricedAsk != null) {
    const looksLikeSpot =
      !isSpot
      && spotFallback != null
      && spotFallback.mid > 0
      && !isTapeContinuityBreak(pricedMid, spotFallback.mid);
    if (looksLikeSpot && orderMid != null) {
      return walkOrderTapeWithSpot(ticket, orderMid, spotFallback);
    }
    return { bid: pricedBid, ask: pricedAsk, mid: pricedMid };
  }
  if (orderMid != null && orderMid > 0) {
    return walkOrderTapeWithSpot(ticket, orderMid, spotFallback);
  }
  if (isSpot && spotFallback && spotFallback.mid > 0) return spotFallback;
  return null;
}

/**
 * Append a live print to the overlay series. A spot↔outright jump starts a
 * new series — never freeze the chart waiting for the next matching print.
 */
export function appendLiveTapeTick<T extends { mid: number }>(
  prev: readonly T[],
  tick: T,
  maxPoints = TAPE_TRAIL_MAX_POINTS,
): T[] {
  if (!(tick.mid > 0) || !Number.isFinite(tick.mid)) return prev as T[];
  const last = prev[prev.length - 1];
  if (last && isTapeContinuityBreak(last.mid, tick.mid)) return [tick];
  const next = [...prev, tick];
  return next.length > maxPoints ? next.slice(-maxPoints) : next;
}

/** Human tape name for LIVE REF / matcher / candles (spot vs 3M outright). */
export function overlayTapeConventionLabel(ticket: {
  instrument?: string | null;
  isSpotReferenced?: boolean;
  maturityMonths?: number | null;
  maturity?: string | null;
  maturityLabel?: string | null;
}): string {
  const inst = tapeInstrument(ticket);
  if (inst === 'spot') return 'spot';
  const months = ticket.maturityMonths;
  if (months != null && months > 0) {
    const n = Number.isInteger(months) ? String(months) : months.toFixed(1);
    return `${n}M outright`;
  }
  const label = ticket.maturityLabel?.replace(/\s*·.*$/, '').trim();
  if (label) return `${label} outright`;
  const m = ticket.maturity;
  if (m && m !== 'spot') return `${m} outright`;
  return 'outright';
}

/**
 * New Book compose must not inherit a previous session's spot trail.
 * Blotter reopen keeps same-tape history.
 */
export function overlayOpenTapeTrail<T extends { mid: number }>(
  history: readonly T[],
  live: { mid: number } | null | undefined,
  bookSession: boolean,
): T[] {
  if (!bookSession) return history.filter(p => p.mid > 0) as T[];
  if (history.length === 0) return [];
  if (live != null && live.mid > 0) {
    return history.filter(
      p => p.mid > 0 && !isTapeContinuityBreak(p.mid, live.mid),
    ) as T[];
  }
  return [];
}

function walkOrderTapeWithSpot(
  ticket: OrderTapeTicket,
  orderMid: number,
  spotFallback?: { bid: number; ask: number; mid: number } | null,
): { bid: number; ask: number; mid: number } {
  const stampedSpot = ticket.ipaQuote?.fxSpot;
  const liveSpot = spotFallback?.mid;
  const mid =
    stampedSpot != null
    && stampedSpot > 0
    && liveSpot != null
    && liveSpot > 0
    && !isTapeContinuityBreak(stampedSpot, liveSpot)
      ? orderMid + (liveSpot - stampedSpot)
      : orderMid;
  const pip = pipSizeForTape(mid);
  return { bid: mid - pip, ask: mid + pip, mid };
}

/**
 * Fills from a previous strip session must not pin the new Book overlay.
 * Blotter view (`bookSession` false) still shows the historical fill.
 */
export function isCurrentOverlayTapeFill(
  fillAtMs: number | null | undefined,
  opts: {
    bookSession?: boolean;
    overlayOpenedAtMs?: number | null;
    trailStartMs?: number | null;
  } = {},
): boolean {
  if (fillAtMs == null || !(fillAtMs > 0) || !Number.isFinite(fillAtMs)) {
    return false;
  }
  if (!opts.bookSession) return true;
  // The DRAWN SERIES is the authority. A book chart is the order's story —
  // it opens at placement (or a lead before the fill) and runs to fill +
  // tail — so a fill inside that span belongs on it no matter when the
  // overlay was opened. Judging by overlay-open time instead hid the pin
  // and every level tag on any booking reopened more than 5s after it
  // filled, which is every reopened booking.
  if (opts.trailStartMs != null && opts.trailStartMs > 0) {
    return fillAtMs >= opts.trailStartMs - 60_000;
  }
  // No trail yet: fall back to the overlay window so a previous session's
  // fill cannot pin itself onto a chart that has not drawn anything.
  if (
    opts.overlayOpenedAtMs != null
    && opts.overlayOpenedAtMs > 0
    && fillAtMs < opts.overlayOpenedAtMs - 5_000
  ) {
    return false;
  }
  return true;
}

/**
 * The instrument whose tape a ticket rests, triggers and records on. A
 * spot-referenced order books a forward but lives on spot — keying it by its
 * booked instrument would compare a spot level against the outright.
 */
export function tapeInstrument(ticket: {
  instrument?: string | null;
  isSpotReferenced?: boolean;
}): string {
  return ticket.isSpotReferenced ? 'spot' : ticket.instrument ?? 'spot';
}

/**
 * The FX series the book tape keeps while the Option desk is open.
 * Option premium is a different chart; keying the trail as `option` wiped
 * the outright candles when the desk switched back to Forward.
 */
export function linearTapeInstrument(
  instrument: string | null | undefined,
  months = 0,
): 'spot' | 'forward' {
  if (instrument === 'spot') return 'spot';
  if (instrument === 'option') return months > 0 ? 'forward' : 'spot';
  return 'forward';
}

/**
 * The execution print on the tape a ticket traded on — what its fill pin,
 * level and audit replay are drawn against. A spot-referenced forward
 * executed on spot (`fxSpot`) and books `fxOutright` = spot + its points;
 * every other ticket's print is its booked rate.
 */
export function tapeFillPrint(ticket: {
  isSpotReferenced?: boolean;
  ipaQuote?: { fxOutright?: number | null; fxSpot?: number | null } | null;
}): number | null {
  return (
    (ticket.isSpotReferenced ? ticket.ipaQuote?.fxSpot : ticket.ipaQuote?.fxOutright)
    ?? null
  );
}

export function tapeQuoteKey(ticket: {
  ccy: string;
  instrument?: string;
  isSpotReferenced?: boolean;
  maturity?: string | null;
  maturityMonths?: number | null;
  stripId?: string;
  stripEdgeIndex?: number;
}): string {
  const ccy = ticket.ccy.toUpperCase();
  const inst = tapeInstrument(ticket);
  // ONE canonical spot tape per currency: every spot-referencing ticket —
  // spot leave orders, spot-stamped strip legs, spot TP/SL brackets —
  // monitors, matches and records against the same series. Tenor/edge
  // suffixes stay on forwards only; two spot tickets must never walk two
  // different "spots" for the same currency.
  if (inst === 'spot') return `${ccy}|spot`;
  // ONE canonical key per tenor regardless of which field carries it. The
  // same ticket used to key as "EUR|forward|t9.00" when it held
  // maturityMonths and as "EUR|forward|9m" when only the maturity label
  // survived (de)serialization — the runtime recorded a fill's tape under
  // the label form while the reopened modal fetched the months form, so
  // 297 recorded rows sat unreadable and the chart opened empty. Keying is
  // the whole game (decisions.md): both spellings must resolve identically.
  const months =
    ticket.maturityMonths != null && ticket.maturityMonths > 0
      ? ticket.maturityMonths
      : maturityLabelMonths(ticket.maturity);
  if (months != null) {
    return `${ccy}|${inst}|t${months.toFixed(2)}`;
  }
  if (ticket.stripId) {
    return `${ccy}|${inst}|s${ticket.stripEdgeIndex ?? 0}`;
  }
  return [ccy, inst, ticket.maturity ?? 'spot'].join('|');
}

/** "9m" → 9 · "1y" → 12 · "2w" → 0.5. Null for anything else. */
export function maturityLabelMonths(
  maturity: string | null | undefined,
): number | null {
  if (!maturity) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([mwy])$/i.exec(maturity.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0) || !Number.isFinite(n)) return null;
  const unit = m[2]!.toLowerCase();
  return unit === 'y' ? n * 12 : unit === 'w' ? n / 4 : n;
}

/**
 * Every key spelling a ticket's tape may have been recorded under — the
 * canonical form first, then the retired maturity-label form for rows
 * persisted before tapeQuoteKey normalized labels. Read-side only.
 */
export function tapeQuoteKeyCandidates(ticket: {
  ccy: string;
  instrument?: string;
  isSpotReferenced?: boolean;
  maturity?: string | null;
  maturityMonths?: number | null;
  stripId?: string;
  stripEdgeIndex?: number;
}): string[] {
  const canonical = tapeQuoteKey(ticket);
  const keys = [canonical];
  const inst = tapeInstrument(ticket);
  if (inst !== 'spot' && ticket.maturity) {
    const legacy = [ticket.ccy.toUpperCase(), inst, ticket.maturity].join('|');
    if (legacy !== canonical) keys.push(legacy);
  }
  return keys;
}

/**
 * True when `quote` is the spot tape of a forward whose limit lives on the
 * outright (~170 EUR pips away). A sell stop must not fire on that print.
 */
export function quoteIsWrongTapeForOrder(
  ticket: {
    limitRate?: number | null;
    restingAnchorRate?: number | null;
    ipaQuote?: { fxOutright?: number | null; fxSpot?: number | null } | null;
  },
  quote: { bid: number; ask: number; mid?: number },
): boolean {
  const limit = ticket.limitRate;
  const mid =
    quote.mid
    ?? ((quote.bid > 0 && quote.ask > 0) ? (quote.bid + quote.ask) / 2 : quote.bid);
  if (limit == null || !(limit > 0) || !(mid > 0)) return false;
  if (!isTapeContinuityBreak(limit, mid)) return false;
  const spot = ticket.ipaQuote?.fxSpot;
  const rest = ticket.restingAnchorRate;
  const outright = ticket.ipaQuote?.fxOutright;
  const near = (a: number | null | undefined, b: number) =>
    a != null && a > 0 && !isTapeContinuityBreak(a, b);
  const far = (a: number | null | undefined, b: number) =>
    a != null && a > 0 && isTapeContinuityBreak(a, b);
  // Quote is the spot print stamped on a forward whose limit is the outright.
  if (far(spot, limit) && near(spot, mid)) return true;
  if (far(rest, limit) && near(rest, mid)) return true;
  // Engine walking market spot while the order's IPA outright sits with the limit
  // (tile mid was also the outright, so rest is not a spot fingerprint).
  if (near(outright, limit) && far(outright, mid)) return true;
  // Leave-order stamps the forward tile as rest and often has no IPA outright.
  // Spot 1.152 vs SL 1.157 / 1.169 must not look like a through-fill.
  if (near(rest, limit) && far(rest, mid)) return true;
  // Strip / leave-order often has no IPA and no rest. A 40+ pip gap from the
  // limit is then the spot tape, not a 9m outright walk.
  if (spot == null && outright == null && rest == null) return true;
  return false;
}

export function tickTimeMs(t: number, fallbackMs = 0): number {
  if (!(t > 0) || !Number.isFinite(t)) return fallbackMs;
  return t > 1e12 ? t : t * 1000;
}

function barUnixSec(ms: number, barSec: number): number {
  const barMs = barSec * 1000;
  return Math.floor(ms / barMs) * barSec;
}

/**
 * Map a fill timestamp onto the OHLC bar that contains it. Lightweight Charts
 * only draws a series marker when `time` matches a candle, so a raw
 * `floor(ms/1000)` (often off the 5s grid) never appears on Path Tape.
 */
export function snapMsToTapeBar(
  ms: number,
  barSec: number,
  barTimes: readonly number[],
): number | null {
  if (!(ms > 0) || !Number.isFinite(ms) || !(barSec > 0) || barTimes.length === 0) {
    return null;
  }
  const target = barUnixSec(tickTimeMs(ms), barSec);
  let best = barTimes[0]!;
  let bestD = Math.abs(best - target);
  if (bestD === 0) return best;
  for (let i = 1; i < barTimes.length; i++) {
    const t = barTimes[i]!;
    const d = Math.abs(t - target);
    if (d < bestD) {
      best = t;
      bestD = d;
      if (bestD === 0) return best;
    }
  }
  return best;
}

/**
 * Build real OHLC candles from ticks. The bar is ONE series — the mid path —
 * so open, high, low and close are all prices the tape actually printed at.
 *
 * It used to take high from the bar's best ask and low from its best bid, to
 * guarantee that a fill (which happens on one side of the book) sat inside the
 * candle it was drawn on. That padded EVERY bar by the half-spread on BOTH
 * sides: a bar whose mid never moved still drew a wick above and below its
 * body, at prices nothing traded at. The desk reads that as a tick the market
 * never made. `widenCandlesToFills` keeps the guarantee where it belongs —
 * on the bars that actually contain a fill, and at the fill's own print.
 *
 * Each new bar opens at the previous bar's close so the tape does not gap. The
 * last bar is the forming candle and updates as new ticks arrive.
 */
export function aggregateTapeCandles(
  ticks: readonly TapeTick[],
  barSec = TAPE_BAR_SEC,
): TapeCandle[] {
  if (ticks.length === 0 || !(barSec > 0)) return [];
  type Acc = { open: number; high: number; low: number; close: number };
  const buckets = new Map<number, Acc>();
  const order: number[] = [];
  ticks.forEach((p, i) => {
    if (!(p.mid > 0) || !Number.isFinite(p.mid)) return;
    // Only the mid is read, so a degraded print with a missing or crossed side
    // cannot invent a range on the bar or invert it.
    const prev = ticks[i - 1];
    const ms = tickTimeMs(p.t, prev ? tickTimeMs(prev.t) + 1 : 0);
    const time = barUnixSec(ms, barSec);
    const acc = buckets.get(time);
    if (!acc) {
      const priorTime = order.length ? order[order.length - 1]! : null;
      const prior = priorTime != null ? buckets.get(priorTime) : undefined;
      // Chain a bar onto the one before it ONLY when the two are adjacent.
      // Across a recording gap — the desk closed the ticket, the server
      // restarted, the database was down — chaining opened the next bar at a
      // close from hours earlier and drew one enormous candle spanning the
      // whole jump, which reads as a market move that never happened. A bar
      // after a gap opens at its own first print; `tapeCandleGaps` reports
      // the break so the chart can draw it as a break.
      const adjacent =
        prior != null
        && priorTime != null
        && time - priorTime <= barSec * TAPE_GAP_BARS;
      const open = adjacent && prior ? prior.close : p.mid;
      buckets.set(time, {
        open,
        high: Math.max(open, p.mid),
        low: Math.min(open, p.mid),
        close: p.mid,
      });
      order.push(time);
      return;
    }
    acc.high = Math.max(acc.high, p.mid);
    acc.low = Math.min(acc.low, p.mid);
    acc.close = p.mid;
  });
  return order.map(time => {
    const acc = buckets.get(time)!;
    return {
      time: time as UTCTimestamp,
      open: acc.open,
      high: acc.high,
      low: acc.low,
      close: acc.close,
    };
  });
}

/**
 * Bars this far apart (in bar widths) are a recording gap, not a quiet market.
 * One empty bucket is ordinary — a second of no prints at a 5s bar — so the
 * break starts at two.
 */
export const TAPE_GAP_BARS = 2;

export type TapeCandleGap = {
  /** Last bar before the break. */
  fromTime: UTCTimestamp;
  /** First bar after it. */
  toTime: UTCTimestamp;
  /** Price the record stopped at, and the one it resumed at. */
  fromPrice: number;
  toPrice: number;
  /** Real elapsed time across the break, for the label. */
  gapMs: number;
};

/**
 * Where a candle series stops being continuous. The chart draws these as an
 * empty band with a dashed join rather than letting two segments sit
 * shoulder to shoulder, which is what made a 29-hour outage look like a
 * 30-pip crash.
 */
export function tapeCandleGaps(
  candles: readonly TapeCandle[],
  barSec: number,
): TapeCandleGap[] {
  if (candles.length < 2 || !(barSec > 0)) return [];
  const gaps: TapeCandleGap[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const cur = candles[i]!;
    const spanSec = Number(cur.time) - Number(prev.time);
    if (spanSec <= barSec * TAPE_GAP_BARS) continue;
    gaps.push({
      fromTime: prev.time,
      toTime: cur.time,
      fromPrice: prev.close,
      toPrice: cur.open,
      gapMs: spanSec * 1000,
    });
  }
  return gaps;
}

/**
 * Bar lengths written to `spot_day_candles`. 1s is the granular picture;
 * 5s / 15s / 30s / 1m are folded from the same prints so a longer window
 * can load a coarser series without re-aggregating 1s rows.
 */
export const SPOT_DAY_STORE_BAR_SECS = [1, 5, 15, 30, 60] as const;
export type SpotDayStoreBarSec = (typeof SPOT_DAY_STORE_BAR_SECS)[number];
export type SpotDayBarSec = SpotDayStoreBarSec;

export const SPOT_DAY_RECORD_BAR_SEC = 60 satisfies SpotDayStoreBarSec;

/** Cap on bars one day-record response may carry, so a 48h window does not ship 1s rows. */
export const SPOT_DAY_MAX_SERVED_BARS = 12_000;

const SPOT_DAY_STORE_BAR_SEC_SET: ReadonlySet<number> = new Set(
  SPOT_DAY_STORE_BAR_SECS,
);

export function isSpotDayStoreBarSec(value: unknown): value is SpotDayStoreBarSec {
  return typeof value === 'number' && Number.isInteger(value) && SPOT_DAY_STORE_BAR_SEC_SET.has(value);
}

/**
 * Finest stored bar that keeps `spanMs` under `SPOT_DAY_MAX_SERVED_BARS`.
 * A one-hour From-window can load 1s; 24h / 48h step up to 15s.
 */
export function pickSpotDayStoreBarSec(spanMs: number): SpotDayStoreBarSec {
  if (!(spanMs > 0) || !Number.isFinite(spanMs)) return SPOT_DAY_RECORD_BAR_SEC;
  const spanSec = spanMs / 1000;
  for (const barSec of SPOT_DAY_STORE_BAR_SECS) {
    if (spanSec / barSec <= SPOT_DAY_MAX_SERVED_BARS) return barSec;
  }
  return SPOT_DAY_RECORD_BAR_SEC;
}

/**
 * Four stamps inside a stored bar so re-aggregating at this length or
 * coarser recovers its OHLC. The 1m offsets stay 0 / 20s / 40s / 59s —
 * that path is what the existing Tape lookback already re-buckets.
 */
export function spotDayBarPathOffsetsMs(
  barSec: number,
): [number, number, number, number] {
  if (barSec === 60) return [0, 20_000, 40_000, 59_000];
  const barMs = Math.max(1, barSec) * 1000;
  return [
    0,
    Math.floor(barMs / 3),
    Math.floor((2 * barMs) / 3),
    Math.max(0, barMs - 1),
  ];
}

/** Longest window one day-record request may span — a local day plus slack. */
export const SPOT_DAY_MAX_WINDOW_MS = 48 * 3600 * 1000;

export function localDayStartMs(nowMs: number): number {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * How far back the Tape view loads. `order` is the order's own story window
 * (placement → fill + tail). The rest move the window's START back from the
 * story's own start — the lead-in to the order, not the hours before now;
 * the stretch before the recorded 1s tape is filled from the day record.
 */
export type TapeLookback = 'order' | '1h' | 'today' | '24h' | '48h';

export const TAPE_LOOKBACK_OPTIONS: readonly TapeLookback[] = [
  'order',
  '1h',
  'today',
  '24h',
  '48h',
];

export function tapeLookbackLabel(lookback: TapeLookback): string {
  switch (lookback) {
    case 'order':
      return 'Order';
    case '1h':
      return 'Last hour';
    case 'today':
      return 'Last day';
    case '24h':
      return '24h';
    case '48h':
      return '48h';
  }
}

export function tapeLookbackTitle(lookback: TapeLookback): string {
  switch (lookback) {
    case 'order':
      return "This order's story: placement to fill";
    case '1h':
      return 'The last hour, via the day record, in this chart’s convention';
    case 'today':
      return 'From midnight of this day, via the day record, in this chart’s convention';
    case '24h':
      return 'The last 24 hours, via the day record, in this chart’s convention';
    case '48h':
      return 'The last 48 hours, via the day record, in this chart’s convention';
  }
}

/**
 * Window start for a lookback, measured back from `anchorMs` — the story's
 * own start (placement, or the market click), or now for a draft with
 * nothing placed. Null for `order`, where the story window decides.
 */
export function tapeLookbackStartMs(
  lookback: TapeLookback,
  anchorMs: number,
): number | null {
  switch (lookback) {
    case 'order':
      return null;
    case '1h':
      return anchorMs - 3600 * 1000;
    case 'today':
      return localDayStartMs(anchorMs);
    case '24h':
      return anchorMs - 24 * 3600 * 1000;
    case '48h':
      return anchorMs - SPOT_DAY_MAX_WINDOW_MS;
  }
}

/**
 * Turn 1m day-record bars into ticks the tape chart can aggregate: four per
 * bar — open at the bucket start, the two wick ends in path order (low then
 * high when the bar closed up), close at the last second — so re-bucketing
 * at 1m or coarser reproduces the bar's OHLC exactly. Bid and ask sit on the
 * mid: the record keeps no spread, and a wick must stay a printed price.
 * `shift` is the leg's points delta, so a forward chart gets its own
 * convention instead of the record's spot.
 */
export function spotDayCandlesToTapeTicks(
  candles: readonly SpotDayCandle[],
  shift: number,
  barSec: number = SPOT_DAY_RECORD_BAR_SEC,
): Array<{ bid: number; ask: number; mid: number; t: number }> {
  const out: Array<{ bid: number; ask: number; mid: number; t: number }> = [];
  const offsets = spotDayBarPathOffsetsMs(barSec);
  for (const bar of candles) {
    if (!isSpotDayCandle(bar) || !(bar.open > 0)) continue;
    const up = bar.close >= bar.open;
    const path: Array<[number, number]> = [
      [offsets[0], bar.open],
      [offsets[1], up ? bar.low : bar.high],
      [offsets[2], up ? bar.high : bar.low],
      [offsets[3], bar.close],
    ];
    for (const [offsetMs, px] of path) {
      const mid = px + shift;
      out.push({ bid: mid, ask: mid, mid, t: bar.t + offsetMs });
    }
  }
  return out;
}

/**
 * Reconstruct option premium ticks from the 1m spot record: sticky delta
 * times notional times the spot move, anchored on the live premium. Bid and
 * ask sit on the reconstructed mid — the record keeps no premium spread.
 */
export function spotDayCandlesToPremiumTicks(
  candles: readonly SpotDayCandle[],
  args: {
    spotNow: number;
    premiumNow: number;
    deltaFrac: number;
    notionalFcy: number;
    quotedUsdPerFcy: boolean;
    barSec?: number;
  },
): Array<{ bid: number; ask: number; mid: number; t: number }> {
  const {
    spotNow,
    premiumNow,
    deltaFrac,
    notionalFcy,
    quotedUsdPerFcy,
    barSec = SPOT_DAY_RECORD_BAR_SEC,
  } = args;
  if (
    !(spotNow > 0)
    || !(premiumNow > 0)
    || !Number.isFinite(deltaFrac)
    || !(notionalFcy > 0)
  ) {
    return [];
  }
  const premiumAt = (spot: number): number => {
    if (!(spot > 0)) return premiumNow;
    const dUsdPerFcy = quotedUsdPerFcy
      ? spot - spotNow
      : 1 / spot - 1 / spotNow;
    return Math.max(1, premiumNow + deltaFrac * notionalFcy * dUsdPerFcy);
  };
  const out: Array<{ bid: number; ask: number; mid: number; t: number }> = [];
  const offsets = spotDayBarPathOffsetsMs(barSec);
  for (const bar of candles) {
    if (!isSpotDayCandle(bar) || !(bar.open > 0)) continue;
    const up = bar.close >= bar.open;
    const path: Array<[number, number]> = [
      [offsets[0], bar.open],
      [offsets[1], up ? bar.low : bar.high],
      [offsets[2], up ? bar.high : bar.low],
      [offsets[3], bar.close],
    ];
    for (const [offsetMs, px] of path) {
      const mid = premiumAt(px);
      out.push({ bid: mid, ask: mid, mid, t: bar.t + offsetMs });
    }
  }
  return out;
}

/**
 * One recorded OHLC bar of the shared spot tape. `t` is the bucket start in
 * unix ms. Open, high, low and close are all the mid path, for the same
 * reason `aggregateTapeCandles` is: a bar is one series, and a wick must be a
 * price the tape printed at rather than the half-spread around it.
 * Unlike that live-tape aggregation, a bar opens at its own first print, not
 * at the previous bar's close — an idle stretch in the record stays a gap
 * instead of being bridged by a wick from a stale price.
 */
export type SpotDayCandle = {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
  /**
   * How many of `ticks` were fresh live overlay prints; the rest are
   * simulated walk steps between them. A bar with `prints: 0` is walk only.
   */
  prints: number;
};

/** What the day record is made of — stated on every payload, never implied. */
export const SPOT_DAY_SOURCE =
  'live overlay prints with a simulated walk between them';

export function isSpotDayCandle(value: unknown): value is SpotDayCandle {
  if (value == null || typeof value !== 'object') return false;
  const bar = value as Record<string, unknown>;
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  return (
    finite(bar.t)
    && finite(bar.open)
    && finite(bar.high)
    && finite(bar.low)
    && finite(bar.close)
    && finite(bar.ticks)
    && finite(bar.prints)
  );
}

/** `GET /api/fx-spot/candles` response. */
export type SpotDayCandlesPayload = {
  pair: string;
  currency: string;
  barSec: SpotDayBarSec;
  source: typeof SPOT_DAY_SOURCE;
  fromMs: number;
  toMs: number;
  /** Closed bars inside the window, ascending by `t`. */
  candles: SpotDayCandle[];
  /** The bar still forming, when its bucket falls inside the window. */
  forming: SpotDayCandle | null;
  serverNowMs: number;
  /** False when no Postgres is configured — the record then lives only in process memory. */
  persisted: boolean;
  /** Set when the Postgres backfill failed and only this process's record is served. */
  warning: string | null;
};

export function spotDayBucketStartMs(
  ms: number,
  barSec: number = SPOT_DAY_RECORD_BAR_SEC,
): number {
  const barMs = barSec * 1000;
  return Math.floor(ms / barMs) * barMs;
}

/**
 * Fold one print into the forming day-record bar. A print in a later bucket
 * closes the current bar and opens the next; a print from an earlier bucket
 * (a late arrival) is dropped rather than rewriting a bar already closed.
 */
export function foldSpotDayTick(
  forming: SpotDayCandle | null,
  tick: TapeTick,
  barSec: number = SPOT_DAY_RECORD_BAR_SEC,
  isLivePrint = false,
): { forming: SpotDayCandle | null; closed: SpotDayCandle | null } {
  const prints = isLivePrint ? 1 : 0;
  if (!(tick.mid > 0) || !Number.isFinite(tick.mid)) {
    return { forming, closed: null };
  }
  const ms = tickTimeMs(tick.t);
  if (!(ms > 0)) return { forming, closed: null };
  const bucket = spotDayBucketStartMs(ms, barSec);
  if (forming && bucket < forming.t) return { forming, closed: null };
  if (forming && bucket === forming.t) {
    return {
      forming: {
        ...forming,
        high: Math.max(forming.high, tick.mid),
        low: Math.min(forming.low, tick.mid),
        close: tick.mid,
        ticks: forming.ticks + 1,
        prints: forming.prints + prints,
      },
      closed: null,
    };
  }
  return {
    forming: {
      t: bucket,
      open: tick.mid,
      high: tick.mid,
      low: tick.mid,
      close: tick.mid,
      ticks: 1,
      prints,
    },
    closed: forming,
  };
}

/**
 * Put a fill's own print inside the bar it is drawn on.
 *
 * A fill happens on one side of the book — a sell-EUR stop at 1.16230 fills on
 * the bid at 1.16228 while the mid is 1.16238 — so on a mid candle the print
 * can sit a fraction of the spread outside its bar, and the desk reads a chart
 * that never reached the level it triggered on. Widening the bar that holds the
 * fill says exactly that much and no more: every other bar stays the mid path,
 * instead of every bar in the series carrying a half-spread wick on both sides
 * to cover the few that hold a fill.
 *
 * Times are not touched, so a caller that already snapped its fills onto bar
 * times (`snapMsToTapeBar`) can widen after it has built its marks.
 *
 * A fill further than `TAPE_FILL_WIDEN_MAX_PIPS` from the bar does NOT widen
 * it. That distance is not a spread — it is a fill from another convention or
 * another leg, and stretching a bar to swallow it produced a candle running
 * the whole height of the plot: a 1m bar at 1.1478 dragged down to a spot TP
 * at 1.14417, 36 pips, twice in one series, which also blew out the axis for
 * every other bar. The cap is deliberately far tighter than
 * `TAPE_MAX_JUMP_PIPS` (40): that band asks "is this a different tape", while
 * this asks "is this the same print a fraction of a spread outside its own
 * mid bar", which is the only thing this function was written to cover. The
 * pin still draws at its own price — it is just no longer allowed to deform
 * the series under it.
 */
/**
 * Put each execution print into the tape at its own time, so the candle
 * built over that moment contains the price the order filled at.
 *
 * `widenCandlesToFills` only stretches a bar that EXISTS at the fill's time.
 * When the chart's series starts after the fill (the in-memory tape begins
 * at a matcher restart, say), the pin was snapped onto the first bar, which
 * never reached the level, and a correctly filled take-profit read as one
 * the market never touched. A print more than a continuity break away from
 * the nearest tick is a different convention and is left out.
 */
export function withFillPrints<T extends TapeTick>(
  ticks: readonly T[],
  fills: readonly { t: number; px: number }[],
): T[] {
  const prints = fills.filter(
    f => Number.isFinite(f.t) && f.t > 0 && Number.isFinite(f.px) && f.px > 0,
  );
  if (prints.length === 0 || ticks.length === 0) return ticks as T[];
  const out = [...ticks];
  for (const fill of prints) {
    const nearest = out.reduce((best, tick) =>
      Math.abs(tick.t - fill.t) < Math.abs(best.t - fill.t) ? tick : best,
    );
    if (isTapeContinuityBreak(nearest.mid, fill.px)) continue;
    // An execution is ONE price: the same on bid, ask and mid, so it sits in
    // the bar whichever side the candles are drawn from. A copy of the
    // nearest tick for its shape, never its marker flag.
    const print = {
      ...nearest,
      t: fill.t,
      mid: fill.px,
      bid: fill.px,
      ask: fill.px,
    } as T & { marker?: boolean };
    delete print.marker;
    out.push(print);
  }
  return out.sort((a, b) => a.t - b.t);
}

export function widenCandlesToFills<
  T extends { time: UTCTimestamp; high: number; low: number },
>(
  candles: readonly T[],
  fills: readonly { time: UTCTimestamp; price: number }[],
): T[] {
  if (candles.length === 0 || fills.length === 0) return candles as T[];
  const reach = new Map<number, number[]>();
  for (const fill of fills) {
    if (!(fill.price > 0) || !Number.isFinite(fill.price)) continue;
    const at = Number(fill.time);
    const held = reach.get(at);
    if (held) held.push(fill.price);
    else reach.set(at, [fill.price]);
  }
  if (reach.size === 0) return candles as T[];
  return candles.map(candle => {
    const held = reach.get(Number(candle.time));
    if (!held) return candle;
    // Measured against the bar, per fill: one out-of-convention print must not
    // drag the bar, and must not stop a genuine one beside it from widening.
    const budget = pipSizeForTape(candle.high) * TAPE_FILL_WIDEN_MAX_PIPS;
    let high = candle.high;
    let low = candle.low;
    for (const price of held) {
      if (price > candle.high && price - candle.high > budget) continue;
      if (price < candle.low && candle.low - price > budget) continue;
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    return high === candle.high && low === candle.low
      ? candle
      : { ...candle, high, low };
  });
}

/**
 * Lock a candle chart's Y range so every reference level stays on the plot,
 * with the same padding whichever chart draws it — Day and Tape are read
 * against each other and the same TP must sit at the same height on both.
 * Null when there is no level to hold on screen (autoscale is fine then).
 */
export function chartPriceRangeWithLevels(
  candles: readonly { low: number; high: number }[],
  levels: readonly number[],
): { min: number; max: number } | null {
  const extras = levels.filter(price => Number.isFinite(price));
  if (extras.length === 0) return null;
  const prices = [
    ...candles.flatMap(candle => [candle.low, candle.high]),
    ...extras,
  ].filter(price => Number.isFinite(price));
  if (prices.length === 0) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const padding = Math.max((max - min) * 0.12, min >= 20 ? 0.01 : 0.0001);
  return { min: min - padding, max: max + padding };
}

/**
 * Keep the price window that is already on screen while the market walks
 * around inside it.
 *
 * `chartPriceRangeWithLevels` is recomputed from the live tape. While a level
 * rests outside the candles it pins one end of the range and the axis holds
 * still, but as soon as the market reaches that level the range is driven by
 * the candles alone and every new high or low rescales it — moving every line
 * and marker drawn on the plot. Re-use the held window unless what must be
 * visible no longer fits inside it, or it has grown far wider than the data
 * needs (a spike that has since left the window).
 */
export function holdChartPriceRange(
  held: { min: number; max: number } | null | undefined,
  want: { min: number; max: number },
  slackFactor = 2.5,
): { min: number; max: number } {
  if (!held || !Number.isFinite(held.min) || !Number.isFinite(held.max)) return want;
  if (held.min > want.min || held.max < want.max) return want;
  if (held.max - held.min > (want.max - want.min) * slackFactor) return want;
  return held;
}
