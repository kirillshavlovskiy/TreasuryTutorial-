# Analytics Design System — Refactoring Guide

## Overview

A unified design system has been created to ensure consistency across all analytics sections (VaR, Liquidity, Hedging Decision, Market Data, etc.).

**Components location:**
- Base components: `components/AnalyticsSystemComponents.tsx`
- Layout templates: `components/test-mode/AnalyticsScenariosPanel.tsx`, `components/test-mode/AnalyticsHeader.tsx`

## Design Pattern

All analytics views follow this structure:

```
┌─────────────────────────────────────────────────────┐
│ Title                                               │
├─────────────────────────────────────────────────────┤
│ [Tabs] [Controls] [Description]                     │
├─────────────────────────────────────────────────────┤
│ ┌──────────────┬────────────────────────────────┐  │
│ │ Scenarios    │ Details + Chart                │  │
│ │ ┌──────────┐ │ ┌────────────────────────────┐ │  │
│ │ │ Card 1   │ │ │                            │ │  │
│ │ └──────────┘ │ │  Primary visualization     │ │  │
│ │ ┌──────────┐ │ │                            │ │  │
│ │ │ Card 2   │ │ │  (chart, table, etc.)      │ │  │
│ │ └──────────┘ │ │                            │ │  │
│ │ ┌──────────┐ │ └────────────────────────────┘ │  │
│ │ │ Card 3   │ │ [Actions]                      │  │
│ │ └──────────┘ │                                │  │
│ └──────────────┴────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Component Reference

### Base Components (`AnalyticsSystemComponents.tsx`)

#### `<AnalyticsSection>`
Wrapper for any analytics section with title + description.

```tsx
<AnalyticsSection
  title="VaR Scenarios"
  description="Select a hedging scenario to see impact on risk"
>
  {/* content */}
</AnalyticsSection>
```

#### `<AnalyticsTabs>`
Consistent tab navigation.

```tsx
<AnalyticsTabs
  tabs={[
    { id: 'curves', label: 'Curves' },
    { id: 'surfaces', label: 'Surfaces' },
  ]}
  activeTab={activeTab}
  onTabChange={setActiveTab}
/>
```

#### `<FilterButtonGroup>`
Button group for filtering/selecting.

```tsx
<FilterButtonGroup
  items={[
    { id: 'eur', label: 'EUR' },
    { id: 'gbp', label: 'GBP' },
  ]}
  selected={selectedCcy}
  onSelect={setCcy}
/>
```

#### `<ScenarioCard>`
Reusable card for scenarios/items in the left panel.

```tsx
<ScenarioCard
  title="Recommended"
  description="Sweet spot — dump costly carry, keep flat names"
  isSelected={scenario.id === selected}
  badge={{ label: 'Review', color: 'amber' }}
  metrics={[
    { label: 'Carry', value: '$207K' },
    { label: 'VAR', value: '$0.7M' },
  ]}
  onClick={() => setSelected(scenario.id)}
/>
```

#### `<MetricCard>`
Display a single metric (label + value + unit).

```tsx
<MetricCard
  label="Carry"
  value={205000}
  unit="$"
  highlight={true}
/>
```

#### `<ActionBar>`
Group of action buttons (Download, Replace, etc.).

```tsx
<ActionBar
  actions={[
    { label: 'Download template', onClick: handleDownload, variant: 'ghost' },
    { label: 'Replace file', onClick: handleReplace, variant: 'primary' },
  ]}
  align="right"
/>
```

#### `<AnalyticsLayout>`
Two-column layout: left panel + right content.

```tsx
<AnalyticsLayout
  leftPanel={<div>Scenarios...</div>}
  rightContent={<div>Chart...</div>}
/>
```

#### `<InfoBanner>`
Status/guidance banner.

```tsx
<InfoBanner
  type="success"
  title="Solution approved"
  message="Carry $207K, VAR $0.7M — within policy limits"
/>
```

### Template Components

#### `<AnalyticsScenariosPanel>`
Ready-to-use layout for scenario selection + detail view (combines several base components).

```tsx
<AnalyticsScenariosPanel
  title="Hedging Scenarios"
  description="Pick a scenario and fine-tune before booking"
  scenarios={[
    { id: '1', name: 'Leave open', ... },
    { id: '2', name: 'Recommended', ... },
    { id: '3', name: 'Fully hedge', ... },
  ]}
  selectedScenarioId={selected}
  onSelectScenario={setSelected}
  detailContent={<YourChart />}
  actions={[
    { label: 'Book', onClick: handleBook, variant: 'primary' },
  ]}
/>
```

#### `<AnalyticsHeader>`
Unified header with tabs, controls, and description.

```tsx
<AnalyticsHeader
  tabs={[
    { id: 'curves', label: 'Curves' },
    { id: 'surfaces', label: 'Surfaces' },
  ]}
  activeTab={tab}
  onTabChange={setTab}
  controls={<FilterButtonGroup ... />}
  description="Upload FXO / Atlas xlsx, or pull all curves from Refinitiv IPA"
/>
```

#### `<AnalyticsView>`
Complete page layout (title + header + tabs + content).

```tsx
<AnalyticsView
  title="Market Data — Group FX (consolidated)"
  tabs={[
    { id: 'curves', label: 'Curves' },
    { id: 'surfaces', label: 'Surfaces' },
  ]}
  activeTab={tab}
  onTabChange={setTab}
  headerControls={<FilterButtonGroup ... />}
>
  {/* content */}
</AnalyticsView>
```

## Refactoring Checklist

### For each analytics section, update in this order:

- [ ] **Identify key sections** in the component (scenarios panel, metrics, detail view, actions)
- [ ] **Replace nested divs with design system components**:
  - Section wrappers → `<AnalyticsSection>`
  - Scenario cards → `<ScenarioCard>`
  - Filter buttons → `<FilterButtonGroup>`
  - Metrics displays → `<MetricCard>` or `<MetricsRow>`
  - Action buttons → `<ActionBar>`
  - Two-column layouts → `<AnalyticsLayout>` or `<AnalyticsScenariosPanel>`
  - Tabs → `<AnalyticsTabs>`
- [ ] **Verify all data/logic is preserved** (no functional changes, only presentation)
- [ ] **Test responsive behavior** (grid, flex wrapping on mobile)
- [ ] **Update imports** to pull from new component files

### Target Views for Refactoring

Priority order (based on complexity and impact):

1. **Market Data** (`ExposureHedgePathChart` + market data view)
   - Straightforward: tabs + curves selection + chart
   - No complex state management
2. **Liquidity Analytics** (`LiquidityAnalyticsView`)
   - Moderate: scenarios + detail chart
   - Core pattern to demo
3. **VaR Analytics** (`VarAnalyticsPanel`)
   - Complex: multiple scenarios, nested modals, rich interactions
   - After simpler examples work
4. **Hedging Decision** (`HedgingDecisionLayer`)
   - Complex: decision tree visualization
   - After core patterns proven

## Example: Refactoring Market Data Curves Section

**Before:**
```tsx
<div className="space-y-4">
  <div>
    <h2 className="text-lg font-semibold">Curves</h2>
    <p className="mt-1 text-sm text-slate-400">Upload FXO rates...</p>
  </div>
  <div className="flex gap-6 border-b border-slate-700">
    {/* manual tabs */}
  </div>
  <div className="flex flex-wrap gap-2">
    {/* manual filter buttons */}
  </div>
  <div className="rounded-lg border p-4">
    {/* chart content */}
  </div>
</div>
```

**After:**
```tsx
import { AnalyticsSection, AnalyticsTabs, FilterButtonGroup, AnalyticsLayout } from '@/components/AnalyticsSystemComponents';

<AnalyticsSection
  title="Curves"
  description="Upload FXO rates or pull from Refinitiv IPA"
>
  <AnalyticsTabs tabs={tabs} activeTab={tab} onTabChange={setTab} />
  <FilterButtonGroup items={ccies} selected={ccy} onSelect={setCcy} />
  <AnalyticsLayout
    leftPanel={<DataTable />}
    rightContent={<Chart />}
  />
</AnalyticsSection>
```

## Styling Notes

- All components use **Tailwind classes** for dark theme (slate palette with sky accent)
- **Responsive:** `lg:` breakpoint for grid layouts (stack on mobile, side-by-side on desktop)
- **Consistent spacing:** `gap-3`, `gap-4`, `gap-6` for standard rhythm
- **Borders:** `border-slate-700` for dividers, `border-slate-600` for inputs
- **Text colors:** `text-slate-100` for primary, `text-slate-400` for secondary

## Migration Timeline

1. **Phase 1 (this session):** Create design system components ✓
2. **Phase 2 (next session):** Refactor Market Data view
3. **Phase 3:** Refactor Liquidity Analytics
4. **Phase 4:** Refactor VaR Analytics (if time permits)

Each phase can be done incrementally without breaking existing functionality.

---

For questions, check component JSDoc comments in `AnalyticsSystemComponents.tsx`.
