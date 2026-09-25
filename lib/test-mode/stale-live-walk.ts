/**
 * Between live overlay / Refinitiv prints, walk a mean-reverting Brownian
 * step around the last real mid. A new external mid snaps the tape back —
 * it must not keep drifting away from the live feed, and it must never
 * re-seed from the FXOCalculator 2M outright (~1.1557).
 */

import { pipSizeOf, walkSpot, type SimSpotQuote } from './sim-ticket-price';

export const STALE_LIVE_STEP_MS = 1_000;
export const STALE_LIVE_MAX_STEPS = 8;
/** Mid must move this many pips to count as a new external print. */
export const NEW_LIVE_PRINT_PIPS = 0.25;

export type StaleLiveWalkState = {
  /** Last real overlay/Refinitiv print (mean-revert target). */
  live: SimSpotQuote;
  liveAsOf: string | null;
  walked: SimSpotQuote;
  walkedAtMs: number;
};

/** Always Bid ≠ Ask — overlay mids often arrive as a single number. */
export function quoteWithMinSpread(q: SimSpotQuote): SimSpotQuote {
  const mid = q.mid > 0 ? q.mid : (q.bid + q.ask) / 2;
  if (!(mid > 0) || !Number.isFinite(mid)) return q;
  const pip = pipSizeOf(mid);
  const half = Math.max(
    pip,
    (Math.max(q.ask, q.bid) - Math.min(q.ask, q.bid)) / 2,
  );
  return { bid: mid - half, mid, ask: mid + half };
}

export function isNewLivePrint(
  prev: SimSpotQuote | null | undefined,
  next: SimSpotQuote,
): boolean {
  if (!prev || !(prev.mid > 0)) return true;
  if (!(next.mid > 0) || !Number.isFinite(next.mid)) return false;
  const pip = pipSizeOf(Math.max(prev.mid, next.mid));
  return Math.abs(next.mid - prev.mid) >= pip * NEW_LIVE_PRINT_PIPS;
}

/**
 * Snap to `live` when the external print moved; otherwise walk `walkSpot`
 * once per elapsed second around that last real mid.
 */
export function advanceStaleLiveSpot(
  state: StaleLiveWalkState | null,
  liveRaw: SimSpotQuote,
  liveAsOf: string | null,
  nowMs: number,
  rand: () => number = Math.random,
): { state: StaleLiveWalkState; snapped: boolean } {
  const live = quoteWithMinSpread(liveRaw);
  if (!state || isNewLivePrint(state.live, live)) {
    return {
      state: {
        live,
        liveAsOf,
        walked: live,
        walkedAtMs: nowMs,
      },
      snapped: true,
    };
  }
  const pip = pipSizeOf(live.mid);
  const elapsed = nowMs - state.walkedAtMs;
  const steps =
    elapsed >= STALE_LIVE_STEP_MS
      ? Math.min(
          STALE_LIVE_MAX_STEPS,
          Math.floor(elapsed / STALE_LIVE_STEP_MS),
        )
      : 0;
  let walked = state.walked;
  for (let i = 0; i < steps; i++) {
    walked = walkSpot(walked, live, pip, rand).next;
  }
  return {
    state: {
      live,
      liveAsOf: liveAsOf ?? state.liveAsOf,
      walked: quoteWithMinSpread(walked),
      walkedAtMs:
        steps > 0
          ? state.walkedAtMs + steps * STALE_LIVE_STEP_MS
          : state.walkedAtMs,
    },
    snapped: false,
  };
}
