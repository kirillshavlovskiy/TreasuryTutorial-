'use client';

import { useMemo, useState } from 'react';
import {
  DeskLwChart,
  type LwCandle,
  type TimeInterval,
} from '@/components/test-mode/DeskLwChart';
import type { UTCTimestamp } from 'lightweight-charts';

/**
 * Demo component showing the enhanced DeskLwChart with:
 * - Time interval selection buttons (5s, 15s, 30s, 1m, 5m, 15m, 1h)
 * - Zoom controls (+, -, Fit)
 * - Drag/scroll navigation
 */
export function ChartWithIntervalDemo() {
  const [interval, setInterval] = useState<TimeInterval>(60);

  const candles = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const result: LwCandle[] = [];

    // Generate 200 candles going backwards
    for (let i = 200; i >= 0; i--) {
      const time = (now - i * interval) as UTCTimestamp;
      const basePrice = 1.16 + Math.sin(i / 20) * 0.002;
      const volatility = 0.0005;

      const open = basePrice + (Math.random() - 0.5) * volatility;
      const close = basePrice + (Math.random() - 0.5) * volatility;
      const high = Math.max(open, close) + Math.random() * volatility;
      const low = Math.min(open, close) - Math.random() * volatility;

      result.push({
        time,
        open: Number(open.toFixed(5)),
        high: Number(high.toFixed(5)),
        low: Number(low.toFixed(5)),
        close: Number(close.toFixed(5)),
      });
    }

    return result;
  }, [interval]);

  return (
    <div className="w-full rounded-lg border border-slate-700 bg-slate-950 p-4">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-slate-200">
          EUR/USD · Price Candles
        </h2>
        <p className="text-xs text-slate-500">
          Interval: {interval}s · Bars: {candles.length}
        </p>
      </div>

      <div className="h-96 w-full rounded bg-slate-900">
        <DeskLwChart
          kind="candlestick"
          candles={candles}
          height={400}
          scale="stream"
          showControlBar={true}
          currentInterval={interval}
          onIntervalChange={setInterval}
          priceFormat={{ precision: 5, minMove: 0.00001 }}
        />
      </div>

      <div className="mt-4 space-y-2 text-xs text-slate-400">
        <div className="flex gap-2">
          <span className="w-24 font-semibold">Controls:</span>
          <div className="flex flex-wrap gap-4">
            <span>• Click interval buttons to change timeframe</span>
            <span>• Scroll to zoom</span>
            <span>• Drag to pan</span>
          </div>
        </div>
        <div>
          <span className="font-semibold">Current settings:</span>
          <span className="ml-2">
            {interval === 5 && '5-second bars (high-frequency)'}
            {interval === 15 && '15-second bars'}
            {interval === 30 && '30-second bars'}
            {interval === 60 && '1-minute bars (standard)'}
            {interval === 300 && '5-minute bars'}
            {interval === 900 && '15-minute bars'}
            {interval === 3600 && '1-hour bars (daily view)'}
          </span>
        </div>
      </div>
    </div>
  );
}
