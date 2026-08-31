# Carry Constraint Implementation — Quick Start Guide

## In 5 Minutes

### 1. Import Components
```tsx
import { StepOptimizationCarrySection } from '@/components/StepOptimizationCarrySection';
import { useCarryConstraintValidation } from '@/lib/hooks/useCarryConstraintValidation';
```

### 2. Add Carry Target State
```tsx
const [carryTargetUsdYrM, setCarryTargetUsdYrM] = useState<number | undefined>(200);
```

### 3. Drop in the Section Component
```tsx
<StepOptimizationCarrySection
  solution={currentSolution}
  carryTargetUsdYrM={carryTargetUsdYrM}
  onCarryTargetChange={(newTarget) => {
    // Re-run frontier calculation + pricing
    repriceSolution(newTarget);
  }}
/>
```

**Done.** The component handles:
- ✅ Constraint indicator (green/red)
- ✅ Violation warnings
- ✅ Per-currency breakdown
- ✅ Auto-expand on violation
- ✅ Metadata display

---

## In Your Table

### Add Carry Column Cell with Constraint Feedback

```tsx
<td className={`${tdBase} ${
  solution?.carryViolation && solution.carryViolation > 1e-6
    ? 'bg-red-50 border-l-2 border-red-400'
    : 'bg-purple-50 border-l-2 border-purple-300'
}`}>
  <div className="flex flex-col gap-1">
    <span className={`font-mono font-semibold ${
      solution?.carryViolation && solution.carryViolation > 1e-6
        ? 'text-red-700'
        : 'text-purple-700'
    }`}>
      {(solution?.totalCarryByCcy[r.ccy] ?? 0).toFixed(1)}$k
    </span>
    {solution?.carryViolation && solution.carryViolation > 1e-6 && (
      <span className="text-[9px] text-red-600 font-semibold">
        ⚠️ clamped
      </span>
    )}
  </div>
</td>
```

### Add Total Carry Summary Row

```tsx
<tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
  <td className="px-2 py-2">TOTAL CARRY</td>
  <td colSpan={columns - 1} className={`px-2 py-2 text-right font-mono ${
    solution?.carryViolation && solution.carryViolation > 1e-6
      ? 'bg-red-100 text-red-700'
      : 'bg-purple-100 text-purple-700'
  }`}>
    {solution?.point.totalCarryUsdYr?.toFixed(1) ?? '0'}$k
    {carryTargetUsdYrM && (
      <>
        <span className="mx-1">/</span>
        <span>{carryTargetUsdYrM.toFixed(1)}$k</span>
      </>
    )}
    {solution?.carryViolation && solution.carryViolation > 1e-6 && (
      <span className="ml-2 text-xs font-semibold">
        ⚠️ +{solution.carryViolation.toFixed(1)}$k
      </span>
    )}
  </td>
</tr>
```

---

## Auto-Recalculate on Target Change

```tsx
useEffect(() => {
  if (!carryTargetUsdYrM) return;

  // Rebuild frontier with new target
  const frontier = buildPolicyConstrainedEfficientFrontier({
    legs,
    policy,
    varCapUsdM: policyCapUsd,
    carryTargetUsdYrM, // <-- Pass new target
  });

  // Re-price the current selection
  const newSolution = buildSolutionPick({
    frontier,
    point: frontier.sweet, // or keep current point
    // ...other params...
  });

  setSolution(newSolution);
}, [carryTargetUsdYrM]); // Re-run when target changes
```

---

## Use the Hook Standalone

If you just want constraint state without the full component:

```tsx
const constraintState = useCarryConstraintValidation({
  carryTargetUsdYrM,
  totalCarryUsdYr: solution?.point.totalCarryUsdYr,
  onCarryTargetChange: repriceWithNewTarget,
});

if (constraintState.isViolated) {
  console.warn(
    `Carry constraint violated: ${formatCarryConstraintStatus(constraintState)}`
  );
}

const isCritical = isCriticalCarryViolation(constraintState);
if (isCritical) {
  // Show warning banner
}
```

---

## Check Solution State

```tsx
if (solution) {
  console.log({
    totalCarry: solution.point.totalCarryUsdYr,
    target: carryTargetUsdYrM,
    violation: solution.carryViolation,
    isClamped: solution.carryViolation > 1e-6,
    perCurrency: solution.totalCarryByCcy,
  });
}
```

---

## Common Patterns

### Pattern 1: Show Violation Banner Only for Critical Violations

```tsx
{solution && solution.carryViolation > 50 && (
  <div className="bg-red-100 border-l-4 border-red-500 p-4">
    <h4 className="font-bold text-red-900">⚠️ Critical Constraint Violation</h4>
    <p>Carry exceeds target by {solution.carryViolation.toFixed(2)}$k</p>
  </div>
)}
```

### Pattern 2: Disable Step if Violated

```tsx
<button
  disabled={solution && solution.carryViolation > 1e-6}
  className={solution?.carryViolation && solution.carryViolation > 1e-6 ? 'opacity-50' : ''}
>
  Accept {solution?.carryViolation && solution.carryViolation > 1e-6 ? '(Constraint Violated)' : ''}
</button>
```

### Pattern 3: Toggle Detailed Breakdown

```tsx
const [showBreakdown, setShowBreakdown] = useState(
  solution?.carryViolation && solution.carryViolation > 1e-6 // Auto-expand on violation
);

{showBreakdown && solution && (
  <CarryBreakdownPanel
    totalCarryByCcy={solution.totalCarryByCcy}
    targetCarryUsdYr={carryTargetUsdYrM}
    carryViolation={solution.carryViolation}
  />
)}
```

---

## Debugging

### View Console Logs

When carry is clamped, check browser console:
```
[Frontier Carry Constraint Violation] Distributed 150.123$k > target 100.000$k...
```

### Check Solution Object

```tsx
console.table({
  totalCarry: solution.point.totalCarryUsdYr,
  target: carryTargetUsdYrM,
  violation: solution.carryViolation,
  EUR: solution.totalCarryByCcy.EUR,
  GBP: solution.totalCarryByCcy.GBP,
  JPY: solution.totalCarryByCcy.JPY,
  // ...etc...
});
```

### Verify Clamping Was Applied

```tsx
const total = Object.values(solution.totalCarryByCcy).reduce((s, v) => s + v, 0);
console.assert(
  total <= carryTargetUsdYrM + 1e-6,
  `Carry total ${total} exceeds target ${carryTargetUsdYrM}`
);
```

---

## Styling

### Color Scheme

```css
/* Compliant */
background: rgb(245, 243, 255); /* bg-purple-50 */
border-color: rgb(168, 85, 247); /* border-purple-300 */
color: rgb(88, 28, 135); /* text-purple-700 */

/* Violated */
background: rgb(254, 242, 242); /* bg-red-50 */
border-color: rgb(220, 38, 38); /* border-red-400 */
color: rgb(153, 27, 27); /* text-red-700 */

/* Total Carry Indicator Compliant */
background: rgb(243, 232, 255); /* bg-purple-100 */

/* Total Carry Indicator Violated */
background: rgb(254, 226, 226); /* bg-red-100 */
```

---

## Type Safety

All components are fully typed:

```tsx
import type { SolutionPick } from '@/lib/test-mode/solution-pick';

const solution: SolutionPick | null = null;
// solution.carryViolation: number ✅
// solution.totalCarryByCcy: Record<string, number> ✅
// solution.point.totalCarryUsdYr: number | undefined ✅
```

---

## Testing in Storybook (Optional)

```tsx
import { StepOptimizationCarrySection } from '@/components/StepOptimizationCarrySection';

export const ConstraintViolated = {
  args: {
    solution: {
      carryViolation: 50,
      point: { totalCarryUsdYr: 150 },
      totalCarryByCcy: { EUR: 50, GBP: 40, JPY: 30, AUD: 30 },
      // ...
    },
    carryTargetUsdYrM: 100,
  },
};

export const Compliant = {
  args: {
    solution: {
      carryViolation: 0,
      point: { totalCarryUsdYr: 80 },
      totalCarryByCcy: { EUR: 40, GBP: 30, JPY: 10 },
      // ...
    },
    carryTargetUsdYrM: 100,
  },
};
```

---

## Next Steps

- [ ] Wire `StepOptimizationCarrySection` into your view
- [ ] Add carry column styling to table
- [ ] Test with solutions that exceed target
- [ ] Check console logs for diagnostics
- [ ] Get user feedback on visual indicators
- [ ] Consider auto-recalc vs manual trigger
