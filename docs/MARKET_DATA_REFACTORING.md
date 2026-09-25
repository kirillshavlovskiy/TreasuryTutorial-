# Market Data Panel Refactoring Plan

**Target:** `components/test-mode/DataUploadPanel.tsx` (1700 lines)  
**Goal:** Apply unified analytics design system (tabs, filters, stat cards)  
**Risk Level:** Medium (large file, complex state management)

## Current Structure

```
DataUploadPanel (wrapper div)
├─ <input> file uploader (hidden)
├─ Header (title + scope label)
├─ Tab navigation (4 tabs: curves, surfaces, hist, corr)
├─ Currency filter buttons (if curves/surfaces && multiple currencies)
└─ Content by tab
    ├─ Curves section: FXO uploads + overnight rates + deposits table
    ├─ Surfaces section: IPA vol surface viewer
    ├─ Historical vol section: σ matrix by tenor
    └─ Correlations section: correlation matrix
```

## Refactoring Strategy

### Phase 1: Header & Navigation (Safe)
**Lines 702–815** — Low risk, pure presentation

**Change:**
```tsx
// Before: manual divs
<div className="flex flex-col gap-[22px] rounded-xl...">
  <div className="flex flex-wrap items-start...">
    {/* title */}
  </div>
  <div className="flex gap-1 border-b...">
    {/* tab buttons */}
  </div>
  <div className="inline-flex...">
    {/* currency buttons */}
  </div>

// After: design system
<AnalyticsView
  title={title ?? 'Market data'}
  tabs={[
    { id: 'curves', label: 'Curves' },
    // ... others
  ]}
  activeTab={marketTab}
  onTabChange={setMarketTab}
  headerControls={
    <span className="...">Stored for {scopeLabel}</span>
  }
  description="...">
  
  {marketTab === 'curves' && (
    <FilterButtonGroup
      items={uploadCcys.map(ccy => ({ id: ccy, label: ccy }))}
      selected={previewCcy}
      onSelect={setSelectedCcy}
    />
  )}
```

**Implementation:**
1. Import components at top: `AnalyticsView`, `AnalyticsTabs`, `FilterButtonGroup`
2. Replace outer `<div className="flex flex-col...">` with `<AnalyticsView>`
3. Remove manual tab rendering (lines 737–785) — let `AnalyticsView` handle it
4. Replace manual currency button group (lines 789–814) with `<FilterButtonGroup>`
5. Update `marketTab` state updates to work with new structure
6. Verify: all tab switching, currency selection still works

**Test:**
- [ ] Tabs switch correctly
- [ ] Currency filter shows/hides at right times
- [ ] Visual layout matches (title, description, controls)

---

### Phase 2: Upload Status & Actions (Safe)
**Lines 819–960** — Low risk, replaces manual info boxes with `<InfoBanner>` + `<ActionBar>`

**Change:**
```tsx
// Before: manual status line
<div className="inline-flex items-center gap-1.5 text-[10px] text-slate-600">
  <span className={`h-[5px] w-[5px] rounded-full ${hasUpload ? 'bg-emerald-400' : 'bg-slate-600'}`} />
  {hasUpload ? `Loaded · spot ${rates.asOf?.spotDate}` : 'No file uploaded'}
</div>

// After: design system
<InfoBanner
  type={hasUpload ? 'success' : 'info'}
  message={hasUpload ? `Loaded · spot ${rates.asOf?.spotDate}` : 'No file uploaded'}
/>
```

**Implementation:**
1. Find all "status" div elements showing upload state (lines 824–833, similar in other tabs)
2. Replace with `<InfoBanner type={hasUpload ? 'success' : 'info'} message={...} />`
3. Find all action button groups (Download template, Replace file, etc.)
4. Replace with `<ActionBar actions={[...]} />`

**Test:**
- [ ] Upload status shows correctly in each tab
- [ ] Action buttons work (onClick handlers preserved)
- [ ] Visual styling consistent with design system

---

### Phase 3: Content Sections (Medium Risk)
**Lines 1000+** — Each tab content stays mostly unchanged, just wrapped

**Change:**
```tsx
// Before: content in nested divs
{marketTab === 'curves' && (
  <section className="flex flex-col gap-2.5">
    {/* FXO curve upload UI */}
    {/* Overnight rates table */}
    {/* Deposits table */}
  </section>
)}

// After: wrapped in AnalyticsSection
{marketTab === 'curves' && (
  <>
    <AnalyticsSection title="FXO Curve — Deposits + Swap Points">
      {/* content unchanged */}
    </AnalyticsSection>
    <AnalyticsSection title="Overnight Rates">
      {/* content unchanged */}
    </AnalyticsSection>
  </>
)}
```

**Implementation:**
1. For each tab's main content div, wrap in `<AnalyticsSection>`
2. Extract section title from the `<div className="text-[9px] uppercase...">` labels
3. Keep all internal tables, charts, and logic untouched
4. Verify spacing with new wrapper

**Test:**
- [ ] Each tab's content renders correctly
- [ ] No logic changes (upload, filtering, calculations still work)
- [ ] Visual spacing and hierarchy preserved

---

### Phase 4: Data Tables (Low Risk)
**Lines 1100+** — Tables stay unchanged, just get better visual hierarchy

- No changes needed; they already follow consistent patterns
- Just ensure they work within the new layout grid

---

## Implementation Checklist

- [ ] **Create backup branch** (already on `dev`, so safe)
- [ ] **Phase 1:** Header & navigation
  - [ ] Add imports at top of file
  - [ ] Replace outer div with `<AnalyticsView>`
  - [ ] Remove manual tab/filter rendering
  - [ ] Test tab switching & currency selection
  - [ ] Commit: `refactor(market-data): apply design system to header & tabs`
- [ ] **Phase 2:** Status & actions
  - [ ] Find all status boxes
  - [ ] Replace with `<InfoBanner>`
  - [ ] Find all action button groups
  - [ ] Replace with `<ActionBar>`
  - [ ] Test button clicks & status display
  - [ ] Commit: `refactor(market-data): apply design system to status & actions`
- [ ] **Phase 3:** Content sections
  - [ ] Wrap each tab's main content in `<AnalyticsSection>`
  - [ ] Extract & format section titles
  - [ ] Test each tab
  - [ ] Commit: `refactor(market-data): wrap content sections in design system`
- [ ] **Phase 4:** Verify full end-to-end
  - [ ] Upload file
  - [ ] Switch tabs
  - [ ] Select currencies
  - [ ] Check responsive layout
  - [ ] Commit: `refactor(market-data): unified design system complete`

---

## Key Preservation Points

- ✅ **State management:** No changes to `marketTab`, `previewCcy`, `rates`, etc.
- ✅ **Event handlers:** All `onChange`, `onClick`, file upload handlers stay identical
- ✅ **Data calculations:** Charts, tables, formula logic untouched
- ✅ **Responsive:** Grid layouts responsive by default in design system components

## Rollback Plan

If issues arise:
```bash
git diff HEAD~4 components/test-mode/DataUploadPanel.tsx > market-data.patch
git checkout HEAD~4 components/test-mode/DataUploadPanel.tsx
```

---

## Before & After Example

**Before Phase 1:**
```tsx
<div className="flex flex-col gap-[22px] rounded-xl border border-slate-800 bg-slate-950 px-7 py-6">
  <div className="flex flex-wrap items-start justify-between gap-6 border-b border-slate-800">
    <div><h3>Market data</h3><p>...</p></div>
    <div><span>Stored for {scopeLabel}</span></div>
  </div>
  <div className="flex gap-1 border-b border-slate-800">
    {/* manual tabs */}
  </div>
  {/* content */}
</div>
```

**After Phase 1:**
```tsx
<AnalyticsView
  title="Market data"
  tabs={[...]}
  activeTab={marketTab}
  onTabChange={setMarketTab}
  headerControls={<span>Stored for {scopeLabel}</span>}
  description="...">
  {/* content */}
</AnalyticsView>
```

---

Ready to start Phase 1 when you give the go-ahead.
