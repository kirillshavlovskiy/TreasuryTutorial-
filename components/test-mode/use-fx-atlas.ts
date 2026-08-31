'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FxAtlasJobRequest,
  FxAtlasJobResult,
} from '@/lib/test-mode/fx-atlas-job';

function emptyFxAtlasJobResult(): FxAtlasJobResult {
  return {
    legs: [],
    byCcy: { carry: {}, indiv: {}, usd: {}, local: {} },
    curve: [],
    sweet: null,
    fullyHedged: null,
    unhedged: null,
    marginal: [],
  };
}

export interface FxAtlasState {
  result: FxAtlasJobResult;
  pending: boolean;
  error: string | null;
}

const CACHE_LIMIT = 16;
const DEBOUNCE_MS = 80;

function jobKey(request: FxAtlasJobRequest): string {
  const json = JSON.stringify(request);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < json.length; i += 1) {
    const c = json.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/**
 * Runs the quant-fx-sigma Optimize package on the server. Cached by input hash.
 * The last good result stays on screen while a newer request is in flight.
 */
export function useFxAtlas(
  request: FxAtlasJobRequest | null,
): FxAtlasState {
  const cacheRef = useRef<Map<string, FxAtlasJobResult>>(new Map());
  const [result, setResult] = useState<FxAtlasJobResult>(emptyFxAtlasJobResult);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const key = useMemo(
    () => (request ? jobKey(request) : ''),
    [request],
  );

  useEffect(() => {
    const req = requestRef.current;
    if (!req || key === '') {
      setPending(false);
      return;
    }
    const hit = cacheRef.current.get(key);
    if (hit) {
      setResult(hit);
      setPending(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setPending(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch('/api/test/quant-fx-sigma', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req),
            signal: controller.signal,
          });
          const json = await response.json().catch(() => null) as
            | (FxAtlasJobResult & { error?: string })
            | { error?: string }
            | null;
          if (!response.ok) {
            throw new Error(json && 'error' in json && json.error
              ? json.error
              : `Request failed (${response.status})`);
          }
          if (!json || !('curve' in json) || !Array.isArray(json.curve)) {
            throw new Error('Frontier response was empty');
          }
          const next = json as FxAtlasJobResult;
          cacheRef.current.set(key, next);
          while (cacheRef.current.size > CACHE_LIMIT) {
            const oldest = cacheRef.current.keys().next();
            if (oldest.done) break;
            cacheRef.current.delete(oldest.value);
          }
          if (!cancelled) {
            setResult(next);
            setError(null);
          }
        } catch (err) {
          if (cancelled || controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : 'Frontier request failed');
        } finally {
          if (!cancelled) setPending(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  return { result, pending, error };
}
