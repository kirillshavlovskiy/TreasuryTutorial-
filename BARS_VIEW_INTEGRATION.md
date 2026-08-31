# Bars View Integration Guide

Three visualization levels have been created for the liquidity table. Add them to `UnifiedSimulator.tsx` to enable chart-based data display.

## Files Created

1. **BarVisualizations.tsx** — Reusable bar components
   - `MiniBar` — Single bar with optional label
   - `StackedBar` — Multi-segment bar (e.g., carry breakdown)
   - `DirectionalBar` — Buy/sell positioned bar
   - `BandSummaryCard` — Card layout for band summary
   - `BarLegend` — Legend for bar colors

2. **CompactBarsView.tsx** — Full compact dashboard view (Level B)
   - Shows 5 bands side-by-side per currency
   - Each band displays key metric as bar chart
   - Grid layout, one currency per row

3. **TableBarsToggle.tsx** — Toggle UI + inline cell components (Levels A & C)
   - `ViewModeToggle` — Button selector (Table / Inline Bars / Compact)
   - `InlineBarCell` — Bar replacement for numeric cells
   - `InlineDirectionalCell` — Directional bar for buy/sell
   - `InlineStackedCell` — Stacked bar for multi-component metrics

## Integration Steps

### 1. Add View Mode State to UnifiedSimulator

```typescript
const [viewMode, setViewMode] = useState<'table' | 'bars' | 'compact'>('table');
```

### 2. Add Toggle Button Above Table

```typescript
<div className="flex items-center justify-between mb-4">
  <h2>Liquidity Simulator</h2>
  <ViewModeToggle currentMode={viewMode} onChange={setViewMode} />
</div>
```

### 3. Conditionally Render Views

```typescript
{viewMode === 'compact' ? (
  <CompactBarsView rows={computedWithHedge} />
) : (
  <>
    {/* Existing table code */}
    {/* When viewMode === 'bars', replace cell renders with InlineBarCell */}
  </>
)}
```

### 4. Replace Numeric Cells with Bars (Optional, for 'bars' mode)

In the table rendering loop, conditionally use `InlineBarCell` instead of numeric span:

```typescript
// Current (numeric):
<span className="font-medium">{f2(r.troughCash)}</span>

// With bars mode:
{viewMode === 'bars' ? (
  <InlineBarCell
    value={r.troughCash}
    max={maxTrough}
    color="bg-sky-500"
    label="Trough"
  />
) : (
  <span className="font-medium">{f2(r.troughCash)}</span>
)}
```

## Band Mapping (Core Metrics)

Each band shows one key metric as the primary bar:

| Band | Key Metric | Color | Unit |
|------|-----------|-------|------|
| **LIQUIDITY POOL BOOK** | Trough Cash | `bg-sky-500` | M FCY |
| **CARRY / BUFFER** | Target LP Cash | `bg-amber-500` | M FCY |
| **SWAP** | Swap Near | `bg-emerald-500` (buy) / `bg-red-500` (sell) | M FCY |
| **FX HEDGE** | Fwd Hedge | `bg-rose-500` | M USD |
| **CARRY** | Stacked: Cash + Buffer + Hedge | Multi-color | $k |

## Usage Notes

- **Table view** — Existing numeric table (no changes)
- **Inline Bars** — Same table structure, numeric cells replaced with mini bars
- **Compact view** — Standalone dashboard showing only core metrics, 5 bands per row

## Customization

### Change colors per band:
In `CompactBarsView.tsx`:
```typescript
<BandSummaryCard 
  title="Liquidity Pool Book" 
  bgColor="bg-sky-50"        // Light background
  textColor="text-sky-700"   // Title color
>
```

### Adjust bar sizing:
In `BarVisualizations.tsx`, update `height` prop:
```typescript
<MiniBar height="h-6" />  // Taller bar
<MiniBar height="h-4" />  // Shorter bar
```

### Add more metrics to bands:
In `CompactBarsView.tsx`, add additional `MiniBar` or `StackedBar` components inside each `BandSummaryCard`.

## Example: Swap Band with Outstanding Book

```typescript
<BandSummaryCard title="Swap" bgColor="bg-emerald-50" textColor="text-emerald-700">
  <DirectionalBar
    value={r.swapNear || 0}
    label="Swap Near"
    maxAbsolute={maxSwap}
  />
  <MiniBar
    value={r.swapBook || 0}
    max={maxSwap}
    label="Swap Book"
    color="bg-emerald-400"
  />
</BandSummaryCard>
```

## Testing

1. Open UnifiedSimulator
2. Click "Compact" to see full dashboard view
3. Click "Inline Bars" to see bars embedded in table
4. Click "Table" to return to numeric view
5. Verify bars scale correctly as you edit values

All three modes should display the same underlying data with different visual representations.
