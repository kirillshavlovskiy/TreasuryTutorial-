# Design brief — Cash Carry · All Currencies

**Refinement only** — same dark slate desk UI. No new theme, no light mode, no marketing cards replacing tables.

**Code:** `components/test-mode/CashCarryAnalyticsView.tsx` (portfolio block) · parent shell `VarAnalyticsPanel.tsx`  
**Math:** do not change metric definitions in `lib/test-mode/cash-carry-analytics.ts`

No screenshots required — use component list + sample data below.

---

## Page sequence (Cash Carry tab)

| # | Block | File / component | Action |
|---|--------|------------------|--------|
| 1 | **All currencies** | `CashCarryAnalyticsView` — portfolio table | Scan CCYs @ Tf · click row → expand |
| 2 | **Month schedule** | nested under #1 when row expanded | Dual cash book by month |
| 3 | **Hedging summary** | same file — table | Click CCY → opens modal |
| 4 | **Carry evolution** | same file — `CarryEvolutionBarChart` | Optional · fold by default |

**Modal** (separate brief): `docs/design/hedge-carry-profile-modal-claude-design.md`  
**Shape search** (modal ch.4): `docs/design/shape-search-optimal-strip-claude-design.md`

---

## Components to refine (share this list)

| Component | Contents |
|-----------|----------|
| **Section header** | Title · Tf chip · gear (profile). Avoid duplicating full period pill row if Tf is set in FX Risk. |
| **Portfolio table** | CCY · Total · Do nothing · Δ · Opening · Hedge CF · Residual · FWD · USD int · footer All CCY |
| **Expand panel** | Metric cards (5) · cash path chips · month table · Collapse |
| **Row states** | idle / hover / selected (`bg-emerald-500/[0.12]`) · `hedged` chip · ▸▾ |

---

## Locked style

- Panel: `rounded-xl border border-slate-800 bg-slate-900/60 p-5`
- Section: `rounded-lg border border-slate-700 bg-slate-950/40 p-3`
- Title: `text-[11px] font-semibold uppercase text-amber-200/90`
- Table: `text-[10px] font-mono` · head `text-slate-500`
- Money: `+12.3K` / `+42.00M` (signed)
- Colors: Opening/USD **sky** · Hedge CF **rose** · Residual **violet** · FWD **emerald** · Do nothing **amber** · Total/Δ **emerald** emphasis
- Expand nest: `border-emerald-500/30 bg-slate-950/70` · settle rows `bg-emerald-500/[0.06]`

---

## Column priority (compact table)

**Always visible:** CCY · Total carry · Do nothing · Δ  
**Secondary (hide first on small width):** Residual · FWD · USD int  
**Tertiary:** Opening · Hedge CF (or show under CCY on mobile)

Optional: thin Δ micro-bar per row (already in code).

---

## Sample data (mockups)

Tf = **12m**. EUR hedged strip, GBP unhedged, PLN partial.

| CCY | Opening | Hedge CF | Total | Do nothing | Δ |
|-----|---------|----------|-------|------------|---|
| EUR | 42.0M | −18.5M | +1.38K | +0.95K | +0.43K |
| GBP | 8.2M | — | +0.04K | +0.04K | 0 |
| PLN | 15.0M | −6.0M | +0.31K | +0.18K | +0.13K |

EUR expanded: settles M3/M6/M9/M12 highlighted.

---

## Problems to fix

1. Header crowded / broken layout (title + pills + gear)
2. Total + Δ not scannable first
3. Too many columns at once — need clear progressive disclosure
4. Expand panel feels bolted on — weak hierarchy vs portfolio table
5. Hedged rows: show **bullet vs strip** at portfolio level (not only “hedged”)

---

## Deliverables

1. **Wire / layout spec** — collapsed portfolio + EUR expanded (text + ASCII or simple blocks)
2. **Component tree** — header / table / expand panel with Tailwind-class notes
3. **Column hide order** + sticky CCY column recommendation
4. **What changed** — bullet list vs current (no pixel-perfect mock required)

---

## Prompt for Claude Design (paste)

```
Refine “Cash carry · all currencies” in a dark FX treasury analytics app.

RULES
- Same existing slate/emerald/amber/violet/sky semantic colors and mono tables
- Refinement only — not a new product visual
- Compact desk density (10px tables, tight padding)
- No screenshots provided — use component list and sample EUR/GBP/PLN data in brief

COMPONENTS
1. Section header: title + Tf + gear
2. Portfolio table: CCY, Total, Do nothing, Δ (hero columns), then Opening/Hedge CF/Residual/FWD/USD
3. Expanded panel: 5 metric cards, cash path chips, month schedule with settle badges

IMPROVE
- Put Total + Δ first in visual hierarchy
- Compact header (don’t stack 6 period pills if Tf is controlled elsewhere)
- Progressive disclosure for split columns
- Stronger selected/expanded state
- Bullet/strip badge on hedged rows

OUTPUT
- Layout spec for collapsed + expanded states
- Tailwind-friendly class notes per component
- Column responsive priority list
```

---

## Implementation map

| Data / state | Source |
|--------------|--------|
| Rows | `multiCcyRows` · `buildCashForecastCarryComparison` |
| Totals | `multiCcyTotals` |
| Expand | `expandedCcy` · `selectCcyRow` · sets `chartCcy` |
| Schedule | `cashForecast` · `buildCashForecastSchedule` |
| Tf options | `FORECAST_PERIOD_OPTIONS` (may live in FX Risk only) |
