import Decimal from 'decimal.js';
import { swapPointsToPriceDelta } from '@/lib/fx-market-rates';
import type { HedgeInstrument } from '@/lib/test-mode/hedge-var';
import type { SimSpotQuote } from '@/lib/test-mode/sim-ticket-price';
import type { VarHorizonId } from '@/lib/test-mode/var-setup';

/**
 * Big Click & Trade Bid/Ask — `/api/fx-spot` (live overlay print, or the
 * server's Brownian walk around that last real mid while the feed is stale).
 *
 * Never the FXOCalculator seed 2M outright (~1.1557). Forwards use a rebased
 * outright (live/walked print + curve points) the caller already priced off
 * that same print. Without a live print the pad stays empty rather than
 * showing a stale series.
 */
export function clickTradePadQuote(args: {
  instrument: HedgeInstrument;
  livePrint: SimSpotQuote | null | undefined;
  pricedBid: number | null | undefined;
  pricedAsk: number | null | undefined;
}): { bid: number; ask: number; mid: number } | null {
  const live = args.livePrint;
  if (!live || !(live.mid > 0)) return null;
  if (args.instrument === 'spot') {
    return { bid: live.bid, ask: live.ask, mid: live.mid };
  }
  const bid = args.pricedBid;
  const ask = args.pricedAsk;
  if (bid != null && ask != null && bid > 0 && ask > 0) {
    return { bid, ask, mid: (bid + ask) / 2 };
  }
  // One outright is enough to stay in FWD. Falling through to live spot
  // put SPOT on the missing side next to a FWD outright — the two tiles
  // then read as a 40–80 pip "spread" that was just mixed conventions.
  const spread = live.ask - live.bid;
  if (bid != null && bid > 0) {
    const other = ask != null && ask > 0 ? ask : bid + spread;
    return { bid, ask: other, mid: (bid + other) / 2 };
  }
  if (ask != null && ask > 0) {
    return { bid: ask - spread, ask, mid: (ask - spread + ask) / 2 };
  }
  return null;
}

/**
 * Spot is not a strip contract. The whole-strip pad stays on FWD outrights
 * (per-leg points) rather than snapping to live spot.
 */
export function stripLevelNeedsSpotReset(_args: {
  structure: 'bullet' | 'strip';
  instrument: HedgeInstrument;
  legCount: number;
}): boolean {
  return false;
}

/**
 * Whether Bid/Ask on the main click-trade pad must snap back to live spot.
 * Strip and Forward book their own FWD outright; Spot is its own contract.
 */
export function clickTradePadResetsToSpot(_args: {
  structure: 'bullet' | 'strip';
  instrument: HedgeInstrument;
  legCount: number;
  selectedLegKey?: string | null;
}): boolean {
  return false;
}

export function stripLevelCanPlace(args: {
  structure: 'bullet' | 'strip';
  instrument: HedgeInstrument;
  legCount: number;
}): boolean {
  return !stripLevelNeedsSpotReset(args);
}

/**
 * Rate the strip-level pad may book. Strip / Forward book each leg at its
 * own FWD outright. Spot is a fallback only on a Spot pad when a leg has
 * no quote of its own.
 */
export function stripLevelFillRate(args: {
  structure: 'bullet' | 'strip';
  instrument: HedgeInstrument;
  target: 'main' | 'leg';
  liveSpotPx: number | null;
  legOutrightPx: number | null;
}): number | null {
  if (args.target === 'leg') return args.legOutrightPx;
  if (args.instrument === 'spot') {
    return args.legOutrightPx ?? args.liveSpotPx;
  }
  return args.legOutrightPx;
}

/**
 * Booked all-in rate of a strip leg whose order executed on spot: the spot
 * print plus the leg's forward points (JPY /100 via swapPointsToPriceDelta).
 * Null when the points are unknown or zero — the caller must then show the
 * print as a spot fill, never label it FWD: the desk read 1.16252 as an M11
 * forward once because the points had silently gone missing. Decimal end to
 * end — this is the rate a matcher fill books, and float addition drifts
 * (1.16529 + 42.01 pips read 1.1694909999999998).
 */
export function bookedForwardFromSpotFill(args: {
  fillPx: number | null | undefined;
  points: number | null | undefined;
  ccy: string;
}): number | null {
  const { fillPx, points } = args;
  if (fillPx == null || !Number.isFinite(fillPx) || fillPx <= 0) return null;
  if (points == null || !Number.isFinite(points) || points === 0) return null;
  return new Decimal(fillPx)
    .plus(new Decimal(points).times(swapPointsToPriceDelta(1, args.ccy)))
    .toNumber();
}

export function stripSpotTenorFields(): {
  instrument: 'spot';
  maturity: null;
  maturityMonths: 0;
  maturityLabel: null;
} {
  return {
    instrument: 'spot',
    maturity: null,
    maturityMonths: 0,
    maturityLabel: null,
  };
}

/** The tenor-bearing part of a strip leg row. */
export type StripLegTenor = {
  instrument: HedgeInstrument;
  tenor: VarHorizonId;
  months: number;
  label: string;
};

/** A strip leg booked as itself — the shape a live click on the leg books. */
export function stripLegTenorFields(leg: StripLegTenor) {
  return {
    instrument: leg.instrument,
    maturity: leg.instrument === 'spot' ? null : leg.tenor,
    maturityMonths: leg.instrument === 'spot' ? 0 : leg.months,
    maturityLabel: leg.instrument === 'spot' ? null : leg.label,
  };
}

/**
 * An order left on the strip's SPOT tile for one leg. A forward leg books as
 * that forward — its own tenor, exactly what a live click on the row books —
 * while its level rests on and triggers against spot (`isSpotReferenced`),
 * and its fill books spot + the leg's points (bookedForwardFromSpotFill).
 * The points are those of `executedSide` — the quote side the matcher takes
 * the spot print from (restingOrderHitSide) — so spot and points come off
 * one side, as a live click's outright does. Without those points the
 * forward rate cannot be built, so the order keeps the plain spot shape
 * rather than book a forward at a bare spot print.
 */
export function spotTileStripLegFields(
  leg: StripLegTenor,
  points: { bid: number | null | undefined; ask: number | null | undefined },
  executedSide: 'bid' | 'ask',
) {
  const sidePoints = executedSide === 'bid' ? points.bid : points.ask;
  if (
    leg.instrument !== 'forward'
    || sidePoints == null
    || !Number.isFinite(sidePoints)
    || sidePoints === 0
  ) {
    return stripSpotTenorFields();
  }
  return {
    ...stripLegTenorFields(leg),
    isSpotReferenced: true,
    stripLegPoints: sidePoints,
  };
}

/**
 * Whether the desk may open the leave-rate field on a pad and type a level.
 *
 * Both the button that opens the field and the handler behind it have to ask
 * the same question, and they did not: the button allowed `inputsLocked` as
 * long as the pad was in limit mode, while the handler closed the field for
 * `inputsLocked` unconditionally. The pair only diverges in one state — a
 * pre-armed limit pad — and that state is exactly an edit of a working order:
 * `workingHit` restores from the order, which freezes inputs, so the field
 * opened and shut in the same click and the level could never be changed.
 *
 * `locked` (a finished ticket, or a read-only pad) is the one thing that
 * closes it. `inputsLocked` alone must not: it goes true the moment a side is
 * armed, and arming is when the desk wants to type — the same reasoning the
 * effect that clears `leaveOpen` already carries.
 */
export function leaveRateFieldEnabled(args: {
  locked: boolean;
  inputsLocked: boolean;
  limitMode: boolean;
}): boolean {
  if (args.locked) return false;
  return args.limitMode || !args.inputsLocked;
}

/**
 * Whether the strip pad shows a live tradable quote instead of an execution.
 *
 * The rule is about the leg the desk is LOOKING AT, never the ticket that
 * happened to open the panel — that distinction has been got wrong twice.
 * First `restFilled` / `liveFilled` vetoed it, so opening a strip from an
 * executed market leg put a live quote over every executed leg selected
 * afterwards. They were removed and `restOpen` was left, which is the same
 * mistake in the other direction: open the panel from a still-working order
 * and every FREE leg selected afterwards was refused a live quote, showing
 * the opened order's sheet over a leg that had no order at all.
 *
 * With nothing selected the pad is the whole strip's MARKET pad, live
 * whenever a leg is left to trade — also when the panel opened on a working
 * order. That order is shown on its own row (and on its sheet once its row
 * is selected); keeping its sheet on the unselected pad left the tile stuck
 * in order mode, with stale levels, instead of the default market state.
 */
export function stripPadShowsLiveQuote(args: {
  isStrip: boolean;
  freeLegCount: number;
  /** Null when the desk has selected no row. */
  selectedLegKey: string | null;
  /** Is the selected row still the desk's to trade? */
  selectedLegIsFree: boolean;
}): boolean {
  if (!args.isStrip || args.freeLegCount <= 0) return false;
  if (args.selectedLegKey == null) return true;
  return args.selectedLegIsFree;
}
