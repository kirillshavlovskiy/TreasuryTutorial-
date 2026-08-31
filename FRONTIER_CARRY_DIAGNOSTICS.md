# Frontier Carry Target Validation Issues

## Problem

When the Buffer Carry target layer (`carryOptim`) is enabled with a max carry target constraint, the frontier calculation and downstream carry per currency rendering can diverge:

1. **Frontier input constraint:** `carryTargetUsdYrM` is passed to `buildPolicyConstrainedEfficientFrontier()`
2. **Frontier solver:** Respects the carry target when finding the sweet spot
3. **Carry distribution:** When the solution is priced, carry per currency is calculated WITHOUT re-validating against the target

## Root Causes

### 1. Missing carry target validation in `priceSolutionAtPoint()`

**File:** `lib/test-mode/solution-pick.ts` (line 451)

```typescript
// Current (unconstrained):
totalCarryByCcy[p.ccy] = desk * input.overlayT + overlay;

// Should validate:
totalCarryByCcy[p.ccy] = desk * input.overlayT + overlay;
const totalCarry = Object.values(totalCarryByCcy).reduce((s, v) => s + v, 0);
if (totalCarry > maxCarryTarget) {
  // ISSUE: No feedback to user, no clamping, no error
}
```

The function sums carry per currency but **never checks** if the sum exceeds the desk's carry target.

### 2. Overlay leg scaling doesn't respect frontier bounds

**File:** `lib/test-mode/constrained-carry-frontier.ts` (line 476)

When building the frontier with `carryTargetUsdYrM` as input, the sweet spot is selected correctly. But when `priceSolutionAtPoint()` scales the overlay with `overlayT`, it doesn't re-check the constraint:

```typescript
// line 451 in solution-pick.ts
totalCarryByCcy[p.ccy] = desk * input.overlayT + overlay;
// overlayT is [0, 1] but could scale total carry past the target
```

### 3. Dashboard/table display doesn't warn about constraint violation

In the liquidity analytics table, per-currency carry cells show `bufferCarryUsdM` (or equivalent) without:
- Red highlighting when total exceeds target
- A "CONSTRAINT VIOLATED" indicator
- Clamping to max per currency

## Rendering Issues

### Step Optimization Panel (Liquidity Analytics Tab)

When you adjust the max carry target slider, the frontier rebuilds but:

1. **Table doesn't update carry distribution** — stays at prior point
2. **Sum of per-currency carry ≠ frontier sweet-spot total**
3. **No visual feedback** that the constraint changed

## Fix Priority

| Issue | Severity | Location | Fix |
|-------|----------|----------|-----|
| Missing carry sum validation | HIGH | `solution-pick.ts:451` | Add constraint check after line 456 |
| Overlay scaling ignores bound | HIGH | `solution-pick.ts:475-500` | Pass `carryTargetUsdYrM` to `priceSolutionAtPoint()` |
| No constraint violation UI feedback | MEDIUM | Liquidity Analytics table | Add red background / warning icon when violated |
| Carry target not re-synced on dial change | MEDIUM | `UnifiedSimulator` / component state | Re-run pricing when `carryTargetUsdYrM` changes |

## Recommended Validation Code

### Add to `priceSolutionAtPoint()`

```typescript
export function priceSolutionAtPoint(input: {
  point: PortfolioCarryFrontierPoint;
  scenarioId: SolutionScenarioId;
  result: LiquidityStrategyResult;
  rows: readonly RowState[];
  engine: PortfolioFrontierEngine;
  capLegs?: readonly EfficientCarryLeg[] | null;
  overlayT: number;
  unhedged: boolean;
  carryTargetUsdYrM?: number;  // ADD THIS
}): {
  overlayLegs: EfficientCarryLeg[];
  totalCarryByCcy: Record<string, number>;
  cfarByCcy: Record<string, number>;
} {
  // ... existing logic ...
  
  // AFTER line 456, ADD:
  const totalCarry = Object.values(totalCarryByCcy).reduce((s, v) => s + v, 0);
  if (input.carryTargetUsdYrM != null && totalCarry > input.carryTargetUsdYrM + 1e-6) {
    console.warn(
      `Carry constraint violated: ${totalCarry.toFixed(3)}k > target ${input.carryTargetUsdYrM.toFixed(3)}k`,
      { totalCarryByCcy, point: input.point },
    );
  }
  
  return { overlayLegs, totalCarryByCcy, cfarByCcy };
}
```

### Update `buildSolutionPick()` call site

```typescript
...priced = priceSolutionAtPoint({
  point: input.point,
  // ... existing ...
  carryTargetUsdYrM: input.frontier.carryTargetUsdYrM, // ADD THIS
}),
```

## Test Case: Frontier Validation

```typescript
// Step 1: Set carry target to 100 USD/yr
const carryTarget = 0.1; // $100k

// Step 2: Build frontier with constraint
const frontier = buildPolicyConstrainedEfficientFrontier({
  legs: [...],
  policy: minBalancePolicy,
  varCapUsdM: 5,
  carryTargetUsdYrM: carryTarget, // <-- constraint
});

// Step 3: Select sweet spot (should respect target)
const sweetSpot = frontier.sweet;
console.assert(
  sweetSpot.carryUsdYrM <= carryTarget + 1e-9,
  `Sweet spot carry ${sweetSpot.carryUsdYrM} exceeds target ${carryTarget}`,
);

// Step 4: Price at sweet spot
const pick = buildSolutionPick({
  point: sweetSpot,
  // ...
  frontier,
  policyCapUsd: 5,
});

// Step 5: Validate distributed carry
const sumByCcy = Object.values(pick.totalCarryByCcy).reduce((s, v) => s + v, 0);
console.assert(
  sumByCcy <= carryTarget + 1e-9,
  `Distributed carry ${sumByCcy} exceeds target ${carryTarget}`,
);
```

## Display Feedback

In the table cell for Buffer Carry target, when violated:

```tsx
<td className={`${tdBase} ${
  totalCarrySum > carryTarget + 1e-6 ? 'bg-red-100 border-l-2 border-red-500' : ''
}`}>
  <span className={totalCarrySum > carryTarget + 1e-6 ? 'text-red-700 font-bold' : ''}>
    {totalCarrySum.toFixed(1)}$k
  </span>
  {totalCarrySum > carryTarget + 1e-6 && (
    <span className="ml-1 text-[10px] text-red-600">⚠️ exceeds target</span>
  )}
</td>
```
