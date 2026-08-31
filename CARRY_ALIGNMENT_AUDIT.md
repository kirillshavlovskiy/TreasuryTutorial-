# Carry Parameter Alignment Audit

**Purpose:** Verify that all carry calculations across the platform use the same source and stay synchronized.

**Last Updated:** 2026-08-24

---

## 1. Carry Sources (Single Source of Truth)

### Primary Source: `SolutionPick.point.totalCarryUsdYr`
- **Location:** `lib/test-mode/solution-pick.ts` 
- **Set in:** `buildSolutionPick()` at line ~530
- **Updated in:** `priceSolutionAtPoint()` after clamping (line ~491)
- **Purpose:** The frontier point's carry value (after constraint clamping if applicable)
- **Unit:** USD per year (in thousands, $k/yr)

### Derived Source: `SolutionPick.totalCarryByCcy`
- **Location:** `lib/test-mode/solution-pick.ts`
- **Set in:** `priceSolutionAtPoint()` at line ~447
- **Clamped at:** Lines 472-489 (proportional reduction if violated)
- **Purpose:** Per-currency breakdown of carry (clamped to target if constrained)
- **Unit:** USD per year (in thousands, $k/yr)
- **Invariant:** `SUM(totalCarryByCcy[ccy] for all ccy) === point.totalCarryUsdYr` (must match after clamping)

---

## 2. Display Locations (Must All Show Same Value)

| Component | Location | Field Used | Expected Value | Status |
|-----------|----------|------------|-----------------|--------|
| **Chart Y-Axis** | `PortfolioCarryVarFrontierPlot` (line ~4716) | `solutionPick.point.totalCarryUsdYr` | Clamped total carry | ✅ FIXED |
| **Table per-currency** | `SweetStripSplit` | `solution.totalCarryByCcy[ccy]` | Per-currency clamped | ✅ ALIGNED |
| **Table total row** | `SweetStripSplit` | SUM of `totalCarryByCcy` | Clamped total carry | ⚠️ VERIFY |
| **Carry Constraint Indicator** | `CarryConstraintIndicator.tsx` | `totalCarryUsdYr` + `carryViolation` | Point carry + excess | ⚠️ VERIFY |
| **Step Optimization Section** | `StepOptimizationCarrySection.tsx` | `solution.point.totalCarryUsdYr` | Clamped total carry | ⚠️ VERIFY |
| **Info bar (Chart bottom)** | `LiquidityAnalyticsView.tsx` | Unknown (trace needed) | Should match chart Y | ❌ INVESTIGATE |

---

## 3. Clamping Logic (Must Be Consistent)

### When Carry Is Clamped:
```
IF carryTargetUsdYrM is set AND distributed_total > target:
  scale = target / distributed_total
  FOR each currency:
    totalCarryByCcy[ccy] *= scale
  point.totalCarryUsdYr = SUM(totalCarryByCcy)  ← MUST UPDATE
  carryViolation = distributed_total - target
```

### Locations Where Clamping Occurs:
1. ✅ `priceSolutionAtPoint()` — **PRIMARY** (line 472-491)
   - Clamps `totalCarryByCcy`
   - Updates `point.totalCarryUsdYr` (FIXED 2026-08-24)
   - Logs diagnostic to console

2. ⚠️ Any other location? **AUDIT REQUIRED**
   - Search for `carryTargetUsdYrM` usage across codebase
   - Search for `proportional` + `carry` logic
   - Verify NO other clamping happens independently

---

## 4. Audit Checklist

### Code Verification
- [ ] Search: `grep -r "totalCarryUsdYr" src/` → Find all read locations
- [ ] Search: `grep -r "totalCarryByCcy" src/` → Find all read locations
- [ ] Verify: No location reads `point.totalCarryUsdYr` before `priceSolutionAtPoint()` runs
- [ ] Verify: No location clamps carry except in `priceSolutionAtPoint()`
- [ ] Verify: After clamping, `SUM(totalCarryByCcy) === point.totalCarryUsdYr` ±1e-6

### Display Verification
- [ ] Chart Y value matches table total row
- [ ] Table total row = SUM of per-currency rows
- [ ] Carry Constraint Indicator shows same total as chart
- [ ] Info bar "Chart Y" shows same value as chart Y-axis
- [ ] No "Target ask" or "marker" values differ by >1e-6

### Data Flow Verification
```
buildSolutionPick()
  ↓
priceSolutionAtPoint()
  → totalCarryByCcy (clamped)
  → point.totalCarryUsdYr (MUST be updated to match sum)
  ↓
SolutionPick returned
  ↓
All display locations read from SAME SolutionPick
  → Chart reads: solutionPick.point.totalCarryUsdYr
  → Table reads: solutionPick.totalCarryByCcy (and sums it)
  → Both must equal each other
```

---

## 5. Known Issues & Fixes

### Issue 1: `point.totalCarryUsdYr` Not Updated After Clamping
- **Status:** ✅ FIXED (2026-08-24)
- **Root Cause:** Clamped `totalCarryByCcy` but left `point.totalCarryUsdYr` at unclamped frontier value
- **Fix Applied:** Line 491 in `solution-pick.ts`
  ```typescript
  input.point.totalCarryUsdYr = Object.values(totalCarryByCcy).reduce((s, v) => s + v, 0);
  ```
- **Verification:** Chart Y and table total should now match

### Issue 2: Multiple Independent Carry Calculations
- **Status:** ⚠️ IN PROGRESS
- **Root Cause:** Carry calculated in 3+ independent places
  1. Frontier point: `totalCarryUsdYr`
  2. Per-currency: `totalCarryByCcy`
  3. Info bar: Unknown source
  4. Constraint indicators: May be independent
- **Fix Required:** Audit all display locations, ensure all read from `SolutionPick`

### Issue 3: Carry Violation Metric
- **Status:** ⚠️ VERIFY
- **Definition:** `carryViolation = max(0, distributed_total - target)`
- **Usage:** Displayed in constraint indicator, badges
- **Verify:** Is `distributed_total` the pre-clamp or post-clamp value?
  - Should be: PRE-CLAMP (the excess amount)
  - Currently: Pre-clamp (correct) per line 468-469

---

## 6. Unit Consistency

| Field | Unit | Scale | Example |
|-------|------|-------|---------|
| `point.totalCarryUsdYr` | $k/yr | Thousands | 20927 = $20.927M/year |
| `totalCarryByCcy[ccy]` | $k/yr | Thousands | 3532 = $3.532M/year |
| `carryTargetUsdYrM` | $k/yr | Thousands | 100 = $100k/year target |
| `carryViolation` | $k | Thousands | 50 = $50k excess |

**CRITICAL:** All must use thousands, NOT raw dollars. 1000 = $1M.

---

## 7. Test Plan

### Unit Test: Clamping Updates Point
```typescript
// In solution-pick.carry-constraint.test.ts
describe('Point carry updated after clamping', () => {
  it('point.totalCarryUsdYr should equal sum of clamped totalCarryByCcy', () => {
    const point = { totalCarryUsdYr: 150, portfolioVarUsd: 5.2 };
    const totalCarryByCcy = { EUR: 60, GBP: 60, JPY: 30 }; // 150 total
    const target = 100;
    
    // Clamp
    const scale = target / 150;
    for (const ccy in totalCarryByCcy) {
      totalCarryByCcy[ccy] *= scale;
    }
    point.totalCarryUsdYr = Object.values(totalCarryByCcy).reduce((s, v) => s + v, 0);
    
    // Verify
    expect(point.totalCarryUsdYr).toBeCloseTo(target, 6);
    expect(point.totalCarryUsdYr).toBeCloseTo(
      Object.values(totalCarryByCcy).reduce((s, v) => s + v, 0),
      6
    );
  });
});
```

### Integration Test: Chart and Table Match
```typescript
// In LiquidityAnalyticsView.test.ts (if exists, create if not)
describe('Chart and Table Carry Alignment', () => {
  it('chart Y value should equal table total carry', () => {
    const solution = buildSolutionPick({ /* ... */ });
    
    const chartY = solution.point.totalCarryUsdYr;
    const tableTotal = Object.values(solution.totalCarryByCcy).reduce((s, v) => s + v, 0);
    
    expect(chartY).toBeCloseTo(tableTotal, 6);
  });
});
```

---

## 8. Monitoring & Prevention

### Console Logs to Add
When clamping occurs, log both values for verification:
```typescript
console.log('[Carry Alignment Check]', {
  'point.totalCarryUsdYr': input.point.totalCarryUsdYr,
  'sum(totalCarryByCcy)': Object.values(totalCarryByCcy).reduce((s, v) => s + v, 0),
  'carryTargetUsdYrM': input.carryTargetUsdYrM,
  'carryViolation': carryViolation,
});
```

### Pre-Deployment Checklist
- [ ] All carry values in console logs match
- [ ] Chart Y = Table total = Constraint indicator total (within 1e-6)
- [ ] No "Target ask" vs "marker" discrepancies on chart
- [ ] Info bar matches chart axis
- [ ] Clamping test passes
- [ ] Integration test passes

---

## 9. Future: Single Source Pattern

To prevent this from happening again, establish a pattern:

```typescript
// ❌ WRONG: Multiple independent calculations
const chartCarry = point.totalCarryUsdYr;
const tableCarry = sum(totalCarryByCcy);
const indicatorCarry = calculateCarryIndependently();

// ✅ RIGHT: Single source, derived everywhere else
export const getClampedCarryUsdYr = (solution: SolutionPick): number => {
  return solution.point.totalCarryUsdYr;
};

// All displays use this function
const chartCarry = getClampedCarryUsdYr(solution);
const tableCarry = getClampedCarryUsdYr(solution);
const indicatorCarry = getClampedCarryUsdYr(solution);
```

---

## Sign-Off

- **Issue Identified:** 2026-08-24
- **Root Cause Found:** `point.totalCarryUsdYr` not updated after clamping
- **Fix Applied:** Line 491 in `solution-pick.ts`
- **Status:** Awaiting verification by running app
- **Next:** Audit remaining display locations and implement single-source pattern
