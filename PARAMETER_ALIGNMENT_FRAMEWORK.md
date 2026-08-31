# Parameter Alignment Framework

**Purpose:** Systematically verify that ALL parameters across the platform are calculated once and used consistently everywhere.

**Status:** FRAMEWORK IN PROGRESS — Apply to all parameters

---

## Master Parameter Map

### Core Data Structure: `SolutionPick`

```typescript
interface SolutionPick {
  scenarioId: string;           // ← Param 1
  overlayT: number;             // ← Param 2
  point: PortfolioCarryFrontierPoint;  // ← Container with sub-params
    ├─ portfolioVarUsd: number;  // ← Param 3a (CFaR)
    ├─ totalCarryUsdYr: number;  // ← Param 3b (Carry) [ALIGNED ✅]
    ├─ k: number;               // ← Param 3c (Scale)
    └─ ...other fields
  overlayLegs: EfficientCarryLeg[];  // ← Param 4 (Legs list)
  totalCarryByCcy: Record<string, number>;  // ← Param 5 (Per-currency)
  cfarByCcy: Record<string, number>;        // ← Param 6 (Per-currency CFaR)
  carryViolation: number;       // ← Param 7 (Excess)
}
```

---

## Parameter Alignment Matrix

| # | Parameter | Source File | Source Line | Display Locations | Alignment Status | Audit Date |
|---|-----------|-------------|------------|------------------|------------------|-----------|
| **1** | `scenarioId` | solution-pick.ts | ~510 | Table, Chart legend, Info bar | ⚠️ AUDIT | — |
| **2** | `overlayT` | solution-pick.ts | ~520 | Step optimization section | ⚠️ AUDIT | — |
| **3a** | `portfolioVarUsd` | frontier.ts | ??? | Chart X-axis, Table CFaR col | ⚠️ AUDIT | — |
| **3b** | `totalCarryUsdYr` | solution-pick.ts | 491 (UPDATED) | Chart Y, Table total, Indicators | ✅ FIXED | 2026-08-24 |
| **3c** | `k` | frontier.ts | ??? | Metadata display | ⚠️ AUDIT | — |
| **4** | `overlayLegs` | solution-pick.ts | ~530 | Hedge breakdown? | ⚠️ AUDIT | — |
| **5** | `totalCarryByCcy` | solution-pick.ts | 447-488 | Table per-currency rows | ⚠️ VERIFY | — |
| **6** | `cfarByCcy` | solution-pick.ts | ~448 | Table CFaR column per-ccy | ⚠️ AUDIT | — |
| **7** | `carryViolation` | solution-pick.ts | ~468 | Constraint indicator, badges | ⚠️ AUDIT | — |
| **8** | `carryTargetUsdYrM` | solution-pick.ts param | ??? | Display in buffer section | ⚠️ AUDIT | — |
| **9** | `cfarTailProb` (implicit) | Varies | ??? | VAR calculations | ⚠️ AUDIT | — |
| **10** | `confidence%` | Analytics | ??? | VAR controls, charts | ⚠️ AUDIT | — |

---

## Audit Procedure for Each Parameter

### Template: Parameter X Alignment Audit

```
Parameter: [NAME]
Type: [scalar | array | object | computed]
Primary Source: [file:line where it's created/set]

1. CREATION
   □ Single source of truth identified
   □ No duplication of calculation
   □ No independent recalculation elsewhere
   
2. PROPAGATION
   □ Passed through function parameters correctly
   □ Never modified mid-pipeline
   □ Immutable after creation
   
3. DISPLAY/USAGE
   □ All display locations use same SolutionPick
   □ No re-fetching or recalculation before display
   □ Values match to ±1e-6 precision
   □ Units consistent (k, M, %, etc.)
   
4. DEPENDENCIES
   □ Parameters it depends on: [list]
   □ Parameters that depend on it: [list]
   □ Update order verified (dependencies first)
   
5. TESTS
   □ Unit test: Source calculation correct
   □ Integration test: All displays match
   □ Edge case: Zero, negative, very large values
   
Status: [ ] CLEAN  [ ] NEEDS FIX  [ ] BLOCKED
```

---

## Detailed Audits In Progress

### AUDIT 1: `totalCarryUsdYr` 
**Status:** ✅ **FIXED** (2026-08-24)

**Source:** `lib/test-mode/solution-pick.ts:491`
```typescript
input.point.totalCarryUsdYr = Object.values(totalCarryByCcy).reduce((s, v) => s + v, 0);
```

**Display Locations:**
1. ✅ Chart Y-axis (`PortfolioCarryVarFrontierPlot` line 4716)
2. ✅ Table total row (sum of `totalCarryByCcy`)
3. ⚠️ Constraint indicator (verify reads from same source)
4. ⚠️ Step optimization section (verify reads from same source)
5. ⚠️ Info bar at chart bottom (UNKNOWN SOURCE — INVESTIGATE)

**Invariant:** `point.totalCarryUsdYr === SUM(totalCarryByCcy)` (±1e-6)

---

### AUDIT 2: `totalCarryByCcy` (Per-Currency)
**Status:** ⚠️ **NEEDS VERIFICATION**

**Source:** `lib/test-mode/solution-pick.ts:447-488`
- Created at line 447
- Populated for each currency (priced currencies + overlay legs)
- Clamped at line 488 if violation detected

**Constraints:**
- Each `totalCarryByCcy[ccy]` is carry for ONE currency only
- Sum of all currencies must equal `point.totalCarryUsdYr`
- When clamped, must be scaled proportionally (not per-currency rescaled)

**Display Locations:**
1. Table per-currency rows (one row per currency)
2. Constraint indicator (per-currency breakdown)
3. Carry breakdown panel

**VERIFY:** Does every display location sum these correctly?

---

### AUDIT 3: `carryViolation`
**Status:** ⚠️ **NEEDS CLARIFICATION**

**Source:** `lib/test-mode/solution-pick.ts:468-469`
```typescript
const carryViolation = input.carryTargetUsdYrM != null && Number.isFinite(input.carryTargetUsdYrM)
  ? Math.max(0, totalCarry - input.carryTargetUsdYrM)
  : 0;
```

**Definition:** Excess carry amount (pre-clamp) = `max(0, distributed - target)`

**Display Locations:**
1. Constraint indicator (red/warning when > 1e-6)
2. Badges with "⚠️ clamped" label
3. Critical violation banner (if > 5%)
4. Table status column

**AUDIT QUESTIONS:**
- [ ] Is `carryViolation` the pre-clamp or post-clamp excess?
  - Answer: PRE-CLAMP (correct per line 468)
- [ ] Is it recalculated anywhere else?
  - Answer: UNKNOWN — SEARCH NEEDED
- [ ] Does every display use the same `carryViolation` from `SolutionPick`?
  - Answer: UNKNOWN — AUDIT NEEDED

---

### AUDIT 4: `portfolioVarUsd` (CFaR)
**Status:** ❓ **SOURCE UNKNOWN**

**Expected Source:** `lib/test-mode/frontier.ts` or portfolio-carry-scenarios.ts

**Display Locations:**
1. Chart X-axis label and scale
2. Table CFaR column header
3. Risk metrics panel

**QUESTIONS:**
- [ ] Where is `portfolioVarUsd` calculated?
- [ ] Is it pre-computed on the frontier point or calculated per-scenario?
- [ ] Is it ever adjusted/scaled between frontier and display?
- [ ] Does it match the X-axis tick values on the chart?

---

### AUDIT 5: `overlayT` (Scale Factor)
**Status:** ❓ **USAGE UNCLEAR**

**Source:** `lib/test-mode/solution-pick.ts:520`

**Display Locations:**
1. Step optimization section metadata
2. Solution info panel

**QUESTIONS:**
- [ ] What does overlayT represent? (Scaling factor for overlay legs?)
- [ ] How is it calculated?
- [ ] Does it ever change after creation?
- [ ] Is it used to recalculate anything (like carry) after display?

---

### AUDIT 6: `carryTargetUsdYrM` (Target)
**Status:** ⚠️ **NEEDS ALIGNMENT VERIFICATION**

**Source:** User input or default (parameter to frontier builder)

**Display Locations:**
1. Buffer optimizer controls
2. Constraint indicator (target line)
3. Chart legend
4. Info bar "Target ask +$XXX/yr"

**CRITICAL ISSUE:** Does "Target ask" value match `carryTargetUsdYrM`?
- If not: WHO is calculating a different "target ask"?
- If yes: Make sure it reads from same source

---

## Critical Search Tasks

### Run These Now

```bash
# Find all reads of carry
grep -rn "totalCarryUsdYr" src/ lib/ components/ --include="*.ts" --include="*.tsx"

# Find all reads of CFaR
grep -rn "portfolioVarUsd\|cfarUsd" src/ lib/ components/ --include="*.ts" --include="*.tsx"

# Find all reads of per-currency values
grep -rn "totalCarryByCcy\|cfarByCcy" src/ lib/ components/ --include="*.ts" --include="*.tsx"

# Find all carry calculations (not just reads)
grep -rn "carry\|Carry" src/ lib/ components/ --include="*.ts" --include="*.tsx" | grep -v "import\|//"

# Find all CFaR calculations
grep -rn "cfarTail\|VAR\|portfolioVar" src/ lib/ components/ --include="*.ts" --include="*.tsx"

# Find independent carry calculations
grep -rn "reduce.*carry\|sum.*carry\|total.*carry" src/ lib/ components/ --include="*.ts" --include="*.tsx"
```

---

## Parameter Dependency Graph

```
carryTargetUsdYrM (input)
  ↓
priceSolutionAtPoint()
  ├─→ totalCarryByCcy[] (pre-clamp)
  │   ├─→ (clamped if violation)
  │   └─→ [MUST sum to point.totalCarryUsdYr]
  │
  ├─→ point.totalCarryUsdYr
  │   ├─→ SUM(totalCarryByCcy[]) ✅ NOW ALIGNED
  │   └─→ Used in: Chart Y, Table total, Indicators
  │
  ├─→ carryViolation
  │   ├─→ max(0, totalCarry_pre_clamp - target)
  │   └─→ Used in: Constraint indicator, Badges
  │
  ├─→ cfarByCcy[]
  │   └─→ Used in: Table CFaR column
  │
  └─→ overlayLegs[]
      └─→ Used in: Hedge breakdown?

portfolioVarUsd (from frontier point)
  └─→ Chart X-axis + Table CFaR

scenarioId
  └─→ Table header + Chart legend

confidence% (user input)
  └─→ VAR calculations
  └─→ Chart controls
```

---

## Alignment Rules

### Rule 1: Single Source per Parameter
✅ **One place calculates it**
- Created once
- Modified once (if at all)
- Passed through the call stack unchanged

❌ **Multiple independent calculations**
- Parameter recalculated in display layer
- Carry computed differently in chart vs table
- CFaR fetched from two sources

### Rule 2: Immutability After Creation
✅ **Parameter set, then only read**
```typescript
const carry = calculateCarry(input);  // Calculated once
return { carry, ... };               // Passed as-is

const point = { carry };
display(point.carry);                // Read, never modified
```

❌ **Parameter modified mid-pipeline**
```typescript
let carry = calculateCarry(input);
carry = adjustForDisplay(carry);      // ❌ WRONG
display(carry);
```

### Rule 3: All Displays Use Same Source
✅ **All read from SolutionPick**
```typescript
// Chart
const chartY = solution.point.totalCarryUsdYr;

// Table
const tableTotal = Object.values(solution.totalCarryByCcy).reduce((s, v) => s + v, 0);
// Must equal chartY

// Indicator
const indicatorCarry = solution.point.totalCarryUsdYr;
// Must equal chartY
```

❌ **Different sources**
```typescript
// Chart uses frontier point
const chartCarry = frontierPoint.totalCarryUsdYr;

// Table recalculates
const tableCarry = calculateCarryAgain(input);
// May differ from chartCarry
```

### Rule 4: Unit Consistency
✅ **All in same units**
- All carry: $k/yr (thousands per year)
- All CFaR: $k (thousands)
- All percentages: % (0-100)

❌ **Mixed units**
- Some in dollars, some in thousands
- Some in annual, some in monthly
- Some as percentage, some as decimal

---

## Test Plan

### Test 1: Parameter Consistency After Clamping
```typescript
test('all displays show same clamped carry', () => {
  const solution = buildSolutionPick({
    point: { totalCarryUsdYr: 150 },
    carryTargetUsdYrM: 100,
  });
  
  const pointCarry = solution.point.totalCarryUsdYr;
  const byCcySum = Object.values(solution.totalCarryByCcy).reduce((s, v) => s + v, 0);
  
  expect(pointCarry).toBeCloseTo(byCcySum, 6);
  expect(pointCarry).toBeLessThanOrEqual(100 + 1e-6);
});
```

### Test 2: No Independent Recalculation
```typescript
test('table does not recalculate carry', () => {
  const solution = buildSolutionPick({ /* ... */ });
  const { rerender } = render(<SweetStripSplit solution={solution} />);
  
  const tableTotal = getTableTotalCarry();
  const pointCarry = solution.point.totalCarryUsdYr;
  
  expect(tableTotal).toBeCloseTo(pointCarry, 6);
  
  // Rerender should not change value
  rerender(<SweetStripSplit solution={solution} />);
  expect(getTableTotalCarry()).toBeCloseTo(tableTotal, 6);
});
```

### Test 3: All Indicators Show Same Value
```typescript
test('constraint indicator matches chart', () => {
  const solution = buildSolutionPick({ /* ... */ });
  const { container } = render(
    <>
      <PortfolioCarryVarFrontierPlot solution={solution} />
      <CarryConstraintIndicator solution={solution} />
    </>
  );
  
  const chartY = getChartYValue(container);
  const indicatorCarry = getIndicatorCarryValue(container);
  
  expect(chartY).toBeCloseTo(indicatorCarry, 6);
});
```

---

## Master Checklist

### Phase 1: Audit Complete (In Progress)
- [ ] Map ALL parameters (not just carry)
- [ ] Find source for each parameter
- [ ] List all display locations
- [ ] Check for multiple independent calculations
- [ ] Identify unit inconsistencies

### Phase 2: Fix Critical Issues
- [x] Fix: `point.totalCarryUsdYr` not updated (DONE 2026-08-24)
- [ ] Fix: Any other parameters with multiple sources
- [ ] Fix: Unit inconsistencies (k vs M vs %)
- [ ] Fix: Immutability violations

### Phase 3: Implement Tests
- [ ] Unit tests for each parameter's creation
- [ ] Integration tests for alignment
- [ ] Display tests for value consistency
- [ ] Regression tests for edge cases

### Phase 4: Documentation
- [ ] Document data flow for each parameter
- [ ] Create single-source pattern examples
- [ ] Update team coding standards
- [ ] Add pre-commit hooks to prevent drift

### Phase 5: Monitoring
- [ ] Add console logs for critical parameters
- [ ] Add assertions in display code
- [ ] Monitor for drift in production
- [ ] Quarterly audit re-runs

---

## Prevention: Single-Source Pattern

```typescript
// ❌ OLD: Multiple independent calculations
export function DataDisplay(props) {
  const carry1 = props.solution.point.totalCarryUsdYr;
  const carry2 = calculateCarryAgain(props.input);
  const carry3 = sumCcyValues(props.solution.totalCarryByCcy);
  // carry1, carry2, carry3 may all differ!
}

// ✅ NEW: Single source with derived values
export const getCarryUsdYr = (solution: SolutionPick): number => {
  return solution.point.totalCarryUsdYr;
};

export const getCarryByCcyTotal = (solution: SolutionPick): number => {
  const total = Object.values(solution.totalCarryByCcy).reduce((s, v) => s + v, 0);
  // Assert that it matches source
  console.assert(
    Math.abs(total - getCarryUsdYr(solution)) < 1e-6,
    `Carry mismatch: ${total} vs ${getCarryUsdYr(solution)}`
  );
  return total;
};

export function DataDisplay(props) {
  const carry = getCarryUsdYr(props.solution);  // Single source
  const ccyTotal = getCarryByCcyTotal(props.solution);  // Derived with assertion
  // Now carry === ccyTotal (or assertion fails)
}
```

---

## Next Steps

1. **Run the grep searches above** to find all parameter usages
2. **Complete remaining audits** (CFaR, overlayT, scenarioId, etc.)
3. **Fix any misalignments** found during audits
4. **Implement tests** for each parameter
5. **Document data flow** for the team
6. **Add prevention** patterns to coding standards

---

**Framework created:** 2026-08-24  
**Last updated:** 2026-08-24  
**Owner:** FX Team  
**Status:** ACTIVE AUDIT IN PROGRESS
