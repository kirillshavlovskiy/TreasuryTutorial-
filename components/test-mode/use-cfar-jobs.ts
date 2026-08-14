'use client';

import { useEffect, useRef, useState } from 'react';
import type { CfarBands, CfarJobEvent } from '@/lib/test-mode/cfar-job';
import type { McCfarInput } from '@/lib/test-mode/cfar-montecarlo';

/**
 * A simulation the view wants, keyed by its own inputs. Callers build these
 * synchronously — only the Monte Carlo is expensive, so input assembly stays
 * on the client and just the engine moves to the server.
 */
export interface CfarJobSpec {
  key: string;
  input: McCfarInput;
}

export interface CfarJobsState {
  /** Results by spec key. Absent means not computed yet. */
  results: ReadonlyMap<string, CfarBands>;
  /** True while any requested key is still outstanding. */
  pending: boolean;
  /** Set when a requested key could not be produced (offline, 401, 500, or a
   * job the engine rejected). */
  error: string | null;
}

/** Keeps recent results so flipping a control back is instant and costs no
 * round-trip. Sized for a few full parameter sweeps: one job per currency plus
 * ten frontier points per batch. */
const CACHE_LIMIT = 240;

/**
 * Content-addressed key for a job. Two independently seeded FNV-1a passes are
 * combined rather than one: a single 32-bit hash would collide roughly once in
 * every few thousand distinct inputs over a long session, and a collision here
 * silently shows one currency's numbers under another's.
 */
export function cfarJobKey(scope: string, input: McCfarInput): string {
  const json = JSON.stringify(input);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < json.length; i += 1) {
    const c = json.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  return `${scope}:${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/**
 * Runs `specs` on the server and re-renders as each one lands.
 *
 * Results are cached by key, so a spec whose inputs have not changed is never
 * re-sent and only genuinely new work goes over the wire.
 *
 * The effect keys off what the CALLER asked for, never off what is left to do.
 * Deriving the dependency from the outstanding set instead is self-defeating:
 * claiming the keys empties that set, the dependency changes, React tears the
 * effect down and aborts the request it has just issued, releasing the keys and
 * starting the whole thing again — an unbounded render loop that never
 * completes a single simulation.
 */
export function useCfarJobs(specs: readonly CfarJobSpec[]): CfarJobsState {
  const cacheRef = useRef<Map<string, CfarBands>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  /** Keys the server could not produce, with the reason. Held so a failure
   * surfaces once instead of being retried forever — a key is content-addressed,
   * so any edit to the inputs asks a fresh question and gets a fresh attempt. */
  const failedRef = useRef<Map<string, string>>(new Map());
  const specsRef = useRef<Map<string, CfarJobSpec>>(new Map());
  const aliveRef = useRef(false);
  /** Bumped when a batch settles, to re-examine what is still missing. */
  const [sweep, setSweep] = useState(0);
  /** Bumped as results stream in. Deliberately NOT an effect dependency, so a
   * mid-stream paint cannot cancel the stream feeding it. */
  const [, repaint] = useState(0);

  specsRef.current = new Map(specs.map(s => [s.key, s]));
  const wantedKey = specs.map(s => s.key).join('\u0000');

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const wanted = wantedKey === '' ? [] : wantedKey.split('\u0000');
    const live = new Set(wanted);
    for (const key of failedRef.current.keys()) {
      if (!live.has(key)) failedRef.current.delete(key);
    }
    const keys = wanted.filter(
      key =>
        !cacheRef.current.has(key) &&
        !inFlightRef.current.has(key) &&
        !failedRef.current.has(key),
    );
    const jobs = keys
      .map(key => specsRef.current.get(key))
      .filter((spec): spec is CfarJobSpec => spec != null)
      .map(spec => ({ id: spec.key, input: spec.input }));
    if (jobs.length === 0) return;

    for (const key of keys) inFlightRef.current.add(key);
    const controller = new AbortController();

    void (async () => {
      let fatal: string | null = null;
      try {
        const response = await fetch('/api/test/cfar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobs }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const detail = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(detail?.error ?? `Request failed (${response.status})`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let dirty = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line === '') continue;
            const event = JSON.parse(line) as CfarJobEvent;
            if (event.type === 'result') {
              cacheRef.current.set(event.id, event.bands);
              dirty = true;
            } else if (event.type === 'error') {
              failedRef.current.set(event.id, event.message);
              dirty = true;
            }
          }
          // One render per chunk rather than per line: a chunk often carries
          // several finished jobs and a single paint for the group is enough.
          if (dirty) {
            dirty = false;
            while (cacheRef.current.size > CACHE_LIMIT) {
              const oldest = cacheRef.current.keys().next();
              if (oldest.done) break;
              cacheRef.current.delete(oldest.value);
            }
            repaint(n => n + 1);
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          fatal = err instanceof Error ? err.message : 'Simulation request failed';
        }
      } finally {
        for (const key of keys) {
          inFlightRef.current.delete(key);
          if (fatal != null && !cacheRef.current.has(key)) {
            failedRef.current.set(key, fatal);
          }
        }
        if (aliveRef.current) setSweep(n => n + 1);
      }
    })();

    return () => {
      // Cancel only work nobody is waiting for any more. Render precedes
      // cleanup, so specsRef already holds the incoming set: when the caller
      // changed a parameter every key is stale and the request is dropped
      // mid-flight, but when the list merely grew the batch is left to finish
      // rather than paying for the same Monte Carlo twice.
      const stillWanted = keys.some(key => specsRef.current.has(key));
      if (!stillWanted || !aliveRef.current) controller.abort();
    };
  }, [wantedKey, sweep]);

  let pending = false;
  let error: string | null = null;
  for (const spec of specs) {
    const failure = failedRef.current.get(spec.key);
    if (failure != null) error ??= failure;
    else if (!cacheRef.current.has(spec.key)) pending = true;
  }

  return { results: cacheRef.current, pending, error };
}
