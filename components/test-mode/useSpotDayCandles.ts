'use client';

import { useEffect, useState } from 'react';
import { fetchFxSpotDayCandles } from '@/lib/refinitivPriceClient';
import {
  SPOT_DAY_MAX_WINDOW_MS,
  type SpotDayCandle,
} from '@/lib/test-mode/tape-candles';
import { mergeSpotDayCandles } from '@/lib/test-mode/tenor-pnl-series';

const POLL_MS = 15_000;

export function useSpotDayCandles(ccy: string | null): {
  candles: SpotDayCandle[];
  pair: string | null;
  loading: boolean;
} {
  const [candles, setCandles] = useState<SpotDayCandle[]>([]);
  const [pair, setPair] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ccy || ccy === 'USD') {
      setCandles([]);
      setPair(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setCandles([]);
    setPair(null);
    const load = (first: boolean) => {
      if (first) setLoading(true);
      const toMs = Date.now();
      const fromMs = toMs - SPOT_DAY_MAX_WINDOW_MS;
      void fetchFxSpotDayCandles({ ccy, fromMs, toMs })
        .then(payload => {
          if (cancelled) return;
          setPair(payload.pair);
          setCandles(mergeSpotDayCandles(payload.candles, payload.forming));
        })
        .catch(() => {
          if (!cancelled && first) {
            setCandles([]);
            setPair(null);
          }
        })
        .finally(() => {
          if (!cancelled && first) setLoading(false);
        });
    };
    load(true);
    const id = window.setInterval(() => load(false), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [ccy]);

  return { candles, pair, loading };
}
