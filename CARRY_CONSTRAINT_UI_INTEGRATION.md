# Carry Constraint Validation — UI Integration Guide

## Backend Fixes Applied ✅

### 1. **Carry Distribution Validation** (`lib/test-mode/solution-pick.ts`)
- Added `carryTargetUsdYrM` parameter to `priceSolutionAtPoint()`
- Validates total distributed carry against frontier target
- Proportionally clamps all currencies if target exceeded
- Returns `carryViolation` metric (0 if compliant, >0 if exceeded)

### 2. **Constraint Clamping**
```typescript
// If total carry exceeds target:
if (totalCarry > carryTargetUsdYrM) {
  const scale = carryTargetUsdYrM / totalCarry;
  for (const ccy of Object.keys(totalCarryByCcy)) {
    totalCarryByCcy[ccy] *= scale; // Proportional reduction
  }
}
```

### 3. **Diagnostic Logging**
Console logs now include:
- Distributed carry vs target
- Excess amount and percentage
- Point-level carry and overlayT scale
- Per-currency breakdown for debugging

## UI Components Created ✅

### `CarryConstraintIndicator` Component
Displays carry constraint status header:
```tsx
<CarryConstraintIndicator
  totalCarryUsdYr={solution.point.totalCarryUsdYr}
  targetCarryUsdYr={carryTargetUsdYrM}
  carryViolation={solution.carryViolation}
  label="Total Carry"
  showDetails={true}
/>
```

**Visual feedback:**
- ✅ Green/purple border when compliant
- ❌ Red border + warning icon when violated
- Shows utilization % of target
- Displays excess amount and percentage

### `PerCurrencyCarryRow` Component
Per-currency breakdown row:
```tsx
<PerCurrencyCarryRow
  ccy={ccy}
  carry={totalCarryByCcy[ccy]}
  totalCarryUsdYr={total}
  targetCarryUsdYr={carryTargetUsdYrM}
  carryViolation={solution.carryViolation}
/>
```

**Visual feedback:**
- Mini bar showing carry proportion
- Buy/sell color coding (purple/orange)
- Red clamped indicator when violated
- Respects proportional reduction

### `CarryBreakdownPanel` Component
Full carry breakdown dashboard:
```tsx
<CarryBreakdownPanel
  totalCarryByCcy={solution.totalCarryByCcy}
  targetCarryUsdYr={carryTargetUsdYrM}
  carryViolation={solution.carryViolation}
  showClamped={true}
/>
```

**Features:**
- Sorted by carry magnitude
- Color-coded borders (green/red)
- Per-currency bars + values
- Violation banner if exceeded
- Utilization percentage

## Hook for Target Changes

`useCarryConstraintValidation` hook:
```tsx
const constraintState = useCarryConstraintValidation({
  carryTargetUsdYrM,
  totalCarryUsdYr: solution?.point.totalCarryUsdYr,
  onCarryTargetChange: (newTarget) => {
    // Re-price the solution when target changes
    repriceCurrentSolution(newTarget);
  },
});
```

## Integration Points

### 1. **Liquidity Analytics Table — Step Optimization Section**

Add constraint indicator above the table:

```tsx
{solution && (
  <CarryConstraintIndicator
    totalCarryUsdYr={solution.point.totalCarryUsdYr}
    targetCarryUsdYr={carryTargetUsdYrM}
    carryViolation={solution.carryViolation}
    showDetails={solution.carryViolation > 0.01}
  />
)}
```

### 2. **Per-Currency Carry Column**

Replace numeric cells with constraint-aware rendering:

```tsx
<td className={`${tdBase} ${
  solution.carryViolation > 1e-6 
    ? 'bg-red-50 border-l-2 border-red-400' 
    : 'bg-purple-50 border-l-2 border-purple-300'
}`}>
  <div className="flex flex-col gap-1">
    <span className={`font-mono font-semibold ${
      solution.carryViolation > 1e-6 ? 'text-red-700' : 'text-purple-700'
    }`}>
      {(solution.totalCarryByCcy[r.ccy] ?? 0).toFixed(1)}$k
    </span>
    {solution.carryViolation > 1e-6 && (
      <span className="text-[9px] text-red-600">⚠️ clamped</span>
    )}
  </div>
</td>
```

### 3. **Summary Row (Table Footer)**

Add total carry with constraint validation:

```tsx
<tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
  <td className="px-2 py-2">TOTAL CARRY</td>
  <td colSpan={columns - 1} className={`px-2 py-2 text-right font-mono ${
    solution.carryViolation > 1e-6
      ? 'bg-red-100 text-red-700'
      : 'bg-purple-100 text-purple-700'
  }`}>
    {solution.point.totalCarryUsdYr?.toFixed(1) ?? '0'}$k
    {carryTargetUsdYrM != null && (
      <>
        <span className="mx-1">/</span>
        <span>{carryTargetUsdYrM.toFixed(1)}$k</span>
        {solution.carryViolation > 1e-6 && (
          <span className="ml-2 text-xs">
            ⚠️ exceeds by {solution.carryViolation.toFixed(1)}$k
          </span>
        )}
      </>
    )}
  </td>
</tr>
```

### 4. **Carry Breakdown Sidebar/Panel**

Show detailed breakdown when constraint is violated:

```tsx
{solution && (solution.carryViolation > 1e-6 || expandBreakdown) && (
  <CarryBreakdownPanel
    totalCarryByCcy={solution.totalCarryByCcy}
    targetCarryUsdYr={carryTargetUsdYrM}
    carryViolation={solution.carryViolation}
    showClamped={true}
  />
)}
```

### 5. **Carry Target Dial — Visual Feedback**

Update the slider/input to show status:

```tsx
<div className={`flex items-center gap-2 ${
  constraintState.isViolated ? 'bg-red-50 p-2 rounded border border-red-300' : ''
}`}>
  <label>Max Carry Target</label>
  <input
    type="range"
    value={carryTargetUsdYrM || 0}
    onChange={(e) => setCarryTargetUsdYrM(parseFloat(e.target.value))}
    className="flex-1"
  />
  <span className={`font-mono ${
    constraintState.isViolated ? 'text-red-700 font-bold' : 'text-gray-700'
  }`}>
    {carryTargetUsdYrM?.toFixed(1) ?? '—'}$k
  </span>
  {constraintState.isViolated && (
    <span className="text-xs text-red-600">⚠️ violated</span>
  )}
</div>
```

## Carry Target Changes — Auto-Recalculate

When user adjusts the max carry target slider:

```tsx
useEffect(() => {
  if (!solution || !carryTargetUsdYrM) return;
  
  // Trigger re-pricing with new carry target
  const newSolution = buildSolutionPick({
    ...input,
    frontier, // Will be rebuilt with new carry target
  });
  setSolution(newSolution);
}, [carryTargetUsdYrM]); // Re-run when target changes
```

## Testing the Integration

### Scenario 1: Within Target ✅
1. Set carry target to 500 USD/yr
2. Solution distributes 400 USD/yr across currencies
3. **Expected:** Green border, "80% utilization", no warnings

### Scenario 2: Exceeds Target ❌
1. Set carry target to 100 USD/yr
2. Solution distributes 150 USD/yr across currencies
3. **Expected:** Red border, "⚠️ VIOLATED", proportional clamping applied
4. **Actual values displayed:** 100 USD/yr (clamped, not 150)

### Scenario 3: Target Slider Change
1. Start with compliant solution
2. Drag carry target slider to lower value
3. **Expected:** Solution re-prices automatically, constraint indicator updates

## CSS Classes Used

| State | Background | Border | Text |
|-------|-----------|--------|------|
| Compliant | `bg-purple-50` | `border-purple-300` | `text-purple-700` |
| Violated | `bg-red-50` | `border-red-400` | `text-red-700` |
| Header (violated) | `bg-red-100` | `border-red-300` | `text-red-700` |

## Console Diagnostics

When carry constraint is violated, console logs show:

```
[Frontier Carry Constraint Violation] Distributed 150.123$k > target 100.000$k (excess: 50.123$k). Point: 125.000$k, overlayT: 0.750.
{
  totalCarryByCcy: { EUR: 40.5, USD: 50.2, GBP: 35.1, ... },
  carryViolation: 50.123,
  point: { ... }
}
```

Helps debug:
- Where the over-allocation is coming from
- Which currencies dominate
- Whether the frontier itself miscalculated

## Performance Notes

- Constraint checking is O(n) where n = number of currencies
- Proportional clamping is O(n)
- No impact on frontier calculation (happens earlier)
- Visual updates are instant (no re-compute needed)

## Accessibility

- Red/green colorblind mode: includes ⚠️ icon + text labels
- Screen readers: "Carry constraint violated" announced in indicator
- Keyboard navigation: slider is fully keyboard-accessible
