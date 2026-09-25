import { describe, expect, it } from 'vitest';
import { MatchingEngine } from './matching-engine';

const LIVE = { bid: 1.1622, mid: 1.1623, ask: 1.1624 };

describe('MatchingEngine.mergeSpots', () => {
  it('does not flatten the walk when the same live print is posted again', async () => {
    const e = new MatchingEngine(1_000, 'test');
    e.initializeSpots({ EUR: LIVE });
    await e.step();
    const walked = e.getState().currentSpot.EUR;
    expect(walked).toBeTruthy();
    expect(walked!.mid).not.toBe(LIVE.mid);
    e.mergeSpots({ EUR: LIVE }, false);
    expect(e.getState().currentSpot.EUR!.mid).toBe(walked!.mid);
  });

  it('snaps current and anchor when a new live print arrives', async () => {
    const e = new MatchingEngine(1_000, 'test');
    e.initializeSpots({ EUR: LIVE });
    await e.step();
    const next = { bid: 1.1630, mid: 1.1631, ask: 1.1632 };
    e.mergeSpots({ EUR: next }, false);
    expect(e.getState().currentSpot.EUR!.mid).toBeCloseTo(1.1631, 6);
  });
});

describe('MatchingEngine.applySharedTape', () => {
  it('uses the shared walked quote on the next tick instead of a second step', async () => {
    const e = new MatchingEngine(1_000, 'test');
    e.initializeSpots({ EUR: LIVE });
    const walked = { bid: 1.16250, mid: 1.16260, ask: 1.16270 };
    e.applySharedTape('EUR', walked, LIVE);
    e.applySharedTape('EUR|spot', walked, LIVE);
    await e.step();
    expect(e.getState().currentSpot.EUR!.mid).toBeCloseTo(1.16260, 6);
    expect(e.getState().currentSpot['EUR|spot']!.mid).toBeCloseTo(1.16260, 6);
    expect(e.getState().currentSpot.EUR!.bid).toBeLessThan(
      e.getState().currentSpot.EUR!.ask,
    );
  });
});
