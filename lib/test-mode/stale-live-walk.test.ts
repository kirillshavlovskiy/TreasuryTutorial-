import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EURUSD_MARKET_RATES } from '@/lib/fx-market-rates';
import {
  advanceStaleLiveSpot,
  isNewLivePrint,
  quoteWithMinSpread,
} from './stale-live-walk';

const LIVE = { bid: 1.1622, mid: 1.1623, ask: 1.1624 };
const SEED_2M = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '2M');

describe('advanceStaleLiveSpot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('snaps to the last live mid, not the FXOCalculator 2M seed', () => {
    const { state, snapped } = advanceStaleLiveSpot(null, LIVE, '2026-09-07T12:00:00Z', 1_000);
    expect(snapped).toBe(true);
    expect(state.walked.mid).toBeCloseTo(1.1623, 6);
    expect(state.walked.bid).toBeLessThan(state.walked.ask);
    expect(SEED_2M?.outright?.ask).toBeCloseTo(1.15574, 4);
    expect(Math.abs(state.walked.mid - (SEED_2M?.outright?.ask ?? 0))).toBeGreaterThan(0.005);
  });

  it('walks around the last live mid while the overlay print is unchanged', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const first = advanceStaleLiveSpot(null, LIVE, 't0', 1_000);
    const second = advanceStaleLiveSpot(first.state, LIVE, 't0', 3_000);
    expect(second.snapped).toBe(false);
    expect(second.state.walked.mid).not.toBe(LIVE.mid);
    expect(second.state.walked.bid).toBeLessThan(second.state.walked.ask);
    expect(Math.abs(second.state.walked.mid - LIVE.mid)).toBeLessThan(0.002);
  });

  it('snaps back when a new live print arrives', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const first = advanceStaleLiveSpot(null, LIVE, 't0', 1_000);
    const walked = advanceStaleLiveSpot(first.state, LIVE, 't0', 5_000);
    expect(walked.state.walked.mid).not.toBe(LIVE.mid);
    const nextLive = { bid: 1.1630, mid: 1.1631, ask: 1.1632 };
    const snap = advanceStaleLiveSpot(walked.state, nextLive, 't1', 6_000);
    expect(snap.snapped).toBe(true);
    expect(snap.state.walked.mid).toBeCloseTo(1.1631, 6);
    expect(snap.state.live.mid).toBeCloseTo(1.1631, 6);
  });

  it('opens a pip spread when the overlay returns a single mid', () => {
    const q = quoteWithMinSpread({ bid: 1.16265, ask: 1.16265, mid: 1.16265 });
    expect(q.bid).toBeLessThan(q.mid);
    expect(q.ask).toBeGreaterThan(q.mid);
    expect(q.ask - q.bid).toBeCloseTo(0.0002, 6);
  });
});

describe('isNewLivePrint', () => {
  it('treats an identical overlay mid as stale', () => {
    expect(isNewLivePrint(LIVE, { ...LIVE })).toBe(false);
  });

  it('treats a pip-scale move as a new print', () => {
    expect(isNewLivePrint(LIVE, { bid: 1.1632, mid: 1.1633, ask: 1.1634 })).toBe(true);
  });
});
