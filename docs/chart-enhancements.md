# Chart Enhancements: Interval Selection & Zoom Controls

The `DeskLwChart` component now supports time interval selection and zoom/drag navigation for professional price charting.

## Features Added

### 1. **Time Interval Selection**
Choose from 7 preset intervals:
- **5s** — 5 seconds
- **15s** — 15 seconds  
- **30s** — 30 seconds
- **1m** — 1 minute
- **5m** — 5 minutes
- **15m** — 15 minutes
- **1h** — 1 hour

### 2. **Zoom Controls**
- **Zoom In** — Compress the visible range by 40%
- **Zoom Out** — Expand the visible range by 66%
- **Fit** — Fit all content into view

### 3. **Drag Navigation**
- **Mouse drag** — Pan left/right through the chart
- **Mouse wheel scroll** — Zoom in/out smoothly
- **Touch pinch** — Zoom on touch devices

## Usage

### Basic Example with Control Bar

```tsx
'use client';

import { useState } from 'react';
import {
  DeskLwChart,
  type LwCandle,
  type TimeInterval,
} from '@/components/test-mode/DeskLwChart';

export function PriceChartDemo({ candles }: { candles: LwCandle[] }) {
  const [interval, setInterval] = useState<TimeInterval>(60); // 1 minute

  return (
    <div className="h-96 w-full">
      <DeskLwChart
        kind="candlestick"
        candles={candles}
        height={400}
        scale="stream" // keeps fixed bar width while scrolling
        showControlBar={true}
        currentInterval={interval}
        onIntervalChange={setInterval}
        priceFormat={{ precision: 5, minMove: 0.00001 }}
      />
    </div>
  );
}
```

### Without Control Bar (Manual)

If you want to manage intervals yourself:

```tsx
export function CustomChart({ candles }: { candles: LwCandle[] }) {
  const [interval, setInterval] = useState<TimeInterval>(300); // 5 minutes

  return (
    <div>
      <div className="mb-4 flex gap-2">
        <button onClick={() => setInterval(60)}>1m</button>
        <button onClick={() => setInterval(300)}>5m</button>
        <button onClick={() => setInterval(900)}>15m</button>
      </div>

      <DeskLwChart
        kind="candlestick"
        candles={candles}
        height={400}
        scale="stream"
        priceFormat={{ precision: 5, minMove: 0.00001 }}
      />
    </div>
  );
}
```

## Props Reference

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `showControlBar` | `boolean` | `false` | Show interval + zoom control bar |
| `currentInterval` | `TimeInterval` | - | Current selected interval (5 \| 15 \| 30 \| 60 \| 300 \| 900 \| 3600) |
| `onIntervalChange` | `(interval: TimeInterval) => void` | - | Callback when interval button clicked |

## Interaction Guide

### Keyboard-Free Navigation

1. **Pan the chart:** Click and drag left/right on the chart area
2. **Zoom in:** Scroll up or use the **+** button
3. **Zoom out:** Scroll down or use the **−** button  
4. **Reset zoom:** Click the **Fit** button

### Combining with Other Features

```tsx
<DeskLwChart
  kind="candlestick"
  candles={candles}
  height={400}
  scale="stream"
  showControlBar={true}
  currentInterval={interval}
  onIntervalChange={setInterval}
  
  // Still supports existing features:
  markerTime={selectedTime}
  onHoverTime={setHoverTime}
  onClickTime={setClickTime}
  priceFormat={{ precision: 5, minMove: 0.00001 }}
/>
```

## Implementation Details

- **Control bar height:** 36px (added to total height)
- **Interval stored state:** Managed by parent component (not internal state)
- **Zoom levels:** Logarithmic scaling; each zoom-in = ×0.6, zoom-out = ÷0.6
- **Drag navigation:** Uses pointer events with capture for smooth panning
- **Mouse wheel:** Native lightweight-charts scroll on non-indexAxis charts

## Performance Notes

- Zoom/pan operations are GPU-accelerated by lightweight-charts
- Interval selection doesn't change data — it's a display hint for your app
- Large candle datasets (5K+ bars) work smoothly at any zoom level
- Touch pinch zoom works on iOS/Android with native browser scaling

## Styling

The control bar uses Tailwind CSS with slate-700/900 theme colors. To customize:

```tsx
// Edit ControlBar component at end of DeskLwChart.tsx
// Change className="bg-slate-900" to your brand color
```

## Future Enhancements

- Keyboard shortcuts (left/right arrow pan, +/- zoom)
- Custom interval presets
- Interval-aware data aggregation (auto-reduce bars at high zoom)
- Comparison mode (two charts side-by-side with linked scroll)
