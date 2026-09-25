/**
 * Background matching service — tape walking and order fill detection.
 * Persists tape history and order executions to database.
 */

import type { SimSpotQuote } from './sim-ticket-price';
import { pipSizeOf, walkSpot } from './sim-ticket-price';
import type { HedgeTicket } from './hedge-var';
import { restingOrderTriggersAt } from './hedge-var';
import { EXEC_LOG_TAG, explainRestingOrder } from './execution-monitor';
import { isTapeContinuityBreak } from './tape-candles';
import { isNewLivePrint } from './stale-live-walk';

export type TapeHistoryRecord = {
  timestamp: number;
  bid: number;
  ask: number;
  mid: number;
  ccy: string;
  sessionId: string;
};

export type OrderExecutionRecord = {
  orderId: string;
  executedAt: number;
  price: number;
  fill: 'bid' | 'ask';
};

export interface IMatchingEngine {
  isRunning: boolean;
  lastTickAt: number | null;
  currentSpot: { [key: string]: SimSpotQuote };
}

export class MatchingEngine {
  private isRunning = false;
  private lastTickAt: number | null = null;
  private currentSpot: { [key: string]: SimSpotQuote } = {};
  /** Mean-revert target per CCY — working forwards park here, not on spot. */
  private walkAnchor: { [key: string]: SimSpotQuote } = {};
  /** Shared /api/fx-spot walk for this beat — skips a second walkSpot step. */
  private sharedTapeThisTick: { [key: string]: SimSpotQuote } = {};
  private tapeHistory: TapeHistoryRecord[] = [];
  private executions: OrderExecutionRecord[] = [];
  private intervalId: NodeJS.Timeout | null = null;
  private onTapeTick: ((record: TapeHistoryRecord) => Promise<void>) | null = null;
  private onOrderExecution:
    | ((record: OrderExecutionRecord) => Promise<void>)
    | null = null;

  constructor(
    private intervalMs: number = 100,
    private sessionId: string = 'default',
  ) {}

  setTapeTickCallback(callback: (record: TapeHistoryRecord) => Promise<void>) {
    this.onTapeTick = callback;
  }

  setOrderExecutionCallback(
    callback: (record: OrderExecutionRecord) => Promise<void>,
  ) {
    this.onOrderExecution = callback;
  }

  /**
   * Initialize spot quotes for all tracked currencies.
   * Anchors the tape walk — all ticks walk around these anchors.
   */
  initializeSpots(spots: { [ccy: string]: SimSpotQuote }) {
    this.currentSpot = { ...spots };
    this.walkAnchor = { ...spots };
  }

  /** Merge quotes without dropping currencies already on the tape. */
  setWalkAnchor(ccy: string, quote: SimSpotQuote) {
    if (quote && quote.mid > 0) this.walkAnchor[ccy] = quote;
  }

  mergeSpots(spots: { [ccy: string]: SimSpotQuote }, allowJump = false) {
    const next = { ...this.currentSpot };
    for (const [ccy, q] of Object.entries(spots)) {
      if (!q || !(q.mid > 0)) continue;
      const cur = next[ccy];
      if (!cur) {
        next[ccy] = q;
        this.walkAnchor[ccy] = q;
        continue;
      }
      if (!allowJump && isTapeContinuityBreak(cur.mid, q.mid)) continue;
      const anchor = this.walkAnchor[ccy] ?? cur;
      if (!isNewLivePrint(anchor, q)) {
        // Same live print the tape is already orbiting — keep the walk.
        continue;
      }
      next[ccy] = q;
      this.walkAnchor[ccy] = q;
    }
    this.currentSpot = next;
  }

  /**
   * Pin this key to the shared fx-spot series for the next tick (pad + matcher).
   * `liveAnchor` is the last real overlay mid; `walked` may already have stepped.
   */
  applySharedTape(key: string, walked: SimSpotQuote, liveAnchor: SimSpotQuote) {
    if (!walked || !(walked.mid > 0)) return;
    const anchor = liveAnchor?.mid > 0 ? liveAnchor : walked;
    this.walkAnchor[key] = anchor;
    this.sharedTapeThisTick[key] = walked;
    if (!this.currentSpot[key]) this.currentSpot[key] = walked;
  }

  /** One public beat — used by the Node matching process. */
  async step() {
    await this.tick();
  }

  /**
   * Start the background tape walker.
   * Emits tape ticks every intervalMs and checks resting orders for fills.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    this.intervalId = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  /**
   * Stop the background service.
   */
  stop() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * One beat of the tape: walk each currency's spot, emit tick, check orders.
   */
  private async tick() {
    const now = Date.now();
    this.lastTickAt = now;

    const newSpots: { [ccy: string]: SimSpotQuote } = {};
    const ticks: TapeHistoryRecord[] = [];
    const shared = this.sharedTapeThisTick;
    this.sharedTapeThisTick = {};

    for (const [ccy, prev] of Object.entries(this.currentSpot)) {
      const taped = shared[ccy];
      const next = taped ?? (() => {
        const anchor = this.walkAnchor[ccy] || prev;
        const pip = pipSizeOf(prev.mid);
        return walkSpot(prev, anchor, pip).next;
      })();
      newSpots[ccy] = next;

      const tick: TapeHistoryRecord = {
        timestamp: now,
        bid: next.bid,
        ask: next.ask,
        mid: next.mid,
        ccy,
        sessionId: this.sessionId,
      };
      ticks.push(tick);
      this.tapeHistory.push(tick);
      // ~30min across all currencies at the 1s beat. Unbounded, this grew
      // by one record per CCY per second for the life of the dev server.
      if (this.tapeHistory.length > 20_000) {
        this.tapeHistory.splice(0, this.tapeHistory.length - 20_000);
      }

      if (this.onTapeTick) {
        await this.onTapeTick(tick);
      }
    }

    this.currentSpot = newSpots;
  }

  /**
   * Check if a resting order triggers on the current tape.
   */
  checkOrderMatch(order: HedgeTicket): { matched: boolean; quote?: { bid: number; ask: number } } {
    const ccy = order.ccy;
    const current = this.currentSpot[ccy];
    if (!current) return { matched: false };

    const quote = { bid: current.bid, ask: current.ask, mid: current.mid };
    const matched = restingOrderTriggersAt(order, quote);
    const decision = explainRestingOrder(order, quote, 0);
    if (matched || decision.outcome !== 'working') {
      console.info(`${EXEC_LOG_TAG} match-check ${decision.reason}`);
    }
    return { matched, quote: matched ? quote : undefined };
  }

  /**
   * Record an order execution (called by an external orchestrator).
   */
  async recordExecution(execution: OrderExecutionRecord) {
    this.executions.push(execution);
    console.info(`${EXEC_LOG_TAG} booked`, execution);
    if (this.onOrderExecution) {
      await this.onOrderExecution(execution);
    }
  }

  getState(): IMatchingEngine {
    return {
      isRunning: this.isRunning,
      lastTickAt: this.lastTickAt,
      currentSpot: { ...this.currentSpot },
    };
  }

  getTapeHistory(): TapeHistoryRecord[] {
    return [...this.tapeHistory];
  }

  getExecutions(): OrderExecutionRecord[] {
    return [...this.executions];
  }
}
