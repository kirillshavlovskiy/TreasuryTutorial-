'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  EfficientFrontierRequest,
  EfficientFrontierResult,
} from '@/lib/test-mode/efficient-frontier-job';
import {
  frontierPointCoords,
  logFrontierChart,
} from '@/lib/test-mode/frontier-chart-debug';

export interface EfficientFrontierState {
  result: EfficientFrontierResult | null;
  pending: boolean;
  error: string | null;
}

const CACHE_LIMIT = 24;
const DEBOUNCE_MS = 80;

function frontierJobKey(request: EfficientFrontierRequest): string {
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
 * Runs the efficient-frontier package on the server. Cached by input hash so
 * flipping a control back is instant. The last good result stays on screen
 * while a newer request is in flight.
 */
export function useEfficientFrontier(
  request: EfficientFrontierRequest | null,
): EfficientFrontierState {
  const cacheRef = useRef<Map<string, EfficientFrontierResult>>(new Map());
  const [result, setResult] = useState<EfficientFrontierResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const key = useMemo(
    () => (request ? frontierJobKey(request) : ''),
    [request],
  );
  const lastRequestKeyRef = useRef('');

  useEffect(() => {
    const req = requestRef.current;
    if (!req || key === '') return;
    if (lastRequestKeyRef.current === key) return;
    lastRequestKeyRef.current = key;
    logFrontierChart('frontier-request', {
      fill: req.askFillMode,
      scenarioId: req.scenarioId,
      requestKey: key,
      carryTargetUsdYr: req.carryTargetUsdYr,
      policyVAR: req.policyVAR,
      scenarioCapUsd: req.scenarioCapUsd,
      customK: req.customK,
    });
  }, [key]);

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
      logFrontierChart('frontier-response', {
        fill: req.askFillMode,
        scenarioId: req.scenarioId,
        requestKey: key,
        cached: true,
        carryBreakdown: hit.carryBreakdown
          ? {
            scenarioId: hit.carryBreakdown.scenarioId,
            k: hit.carryBreakdown.k,
            overlayT: hit.carryBreakdown.overlayT,
            chartX: hit.carryBreakdown.chartX,
            chartY: hit.carryBreakdown.chartY,
          }
          : null,
        solutionFrontierPoints: hit.solutionFrontier?.points.length ?? 0,
      });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setPending(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch('/api/test/efficient-frontier', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req),
            signal: controller.signal,
          });
          const json = await response.json().catch(() => null) as
            | (EfficientFrontierResult & { error?: string })
            | { error?: string }
            | null;
          if (!response.ok) {
            throw new Error(json && 'error' in json && json.error
              ? json.error
              : `Request failed (${response.status})`);
          }
          if (!json || !('results' in json) || !Array.isArray(json.results)) {
            throw new Error('Efficient frontier response was empty');
          }
          const next = json as EfficientFrontierResult;
          cacheRef.current.set(key, next);
          while (cacheRef.current.size > CACHE_LIMIT) {
            const oldest = cacheRef.current.keys().next();
            if (oldest.done) break;
            cacheRef.current.delete(oldest.value);
          }
          if (!cancelled) {
            setResult(next);
            setError(null);
            logFrontierChart('frontier-response', {
              fill: req.askFillMode,
              scenarioId: req.scenarioId,
              requestKey: key,
              cached: false,
              carryBreakdown: next.carryBreakdown
                ? {
                  scenarioId: next.carryBreakdown.scenarioId,
                  k: next.carryBreakdown.k,
                  overlayT: next.carryBreakdown.overlayT,
                  chartX: next.carryBreakdown.chartX,
                  chartY: next.carryBreakdown.chartY,
                }
                : null,
              solutionPick: next.carryBreakdown
                ? frontierPointCoords({
                  portfolioVarUsd: next.carryBreakdown.chartX,
                  totalCarryUsdYr: next.carryBreakdown.chartY,
                  k: next.carryBreakdown.k,
                })
                : null,
              solutionFrontierPoints: next.solutionFrontier?.points.length ?? 0,
            });
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
