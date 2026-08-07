# Claude Design brief — Cash Carry · All Currencies

> Paste this file (or the **Prompt for Claude Design** section) into Claude Design / Claude Artifacts.
> Implementation: `components/test-mode/CashCarryAnalyticsView.tsx` (first `<section>`).
>
> **Style rule:** This is a **refinement of the existing panel**, not a greenfield redesign.
> Reuse the shell, section chrome, segmented control, table density, metric-card recipe,
> and semantic color map below. Improve hierarchy / scanability — do **not** invent a new
> visual language, light theme, or alternate component kit.

---

## Product context

| | |
|---|---|
| **App** | Deel Treasury sandbox — FX Cash Carry analytics (NordTech / Task 01) |
| **Surface** | Analytics → Cash Carry tab |
| **Component** | `CashCarryAnalyticsView` |
| **Section** | “Cash carry · all currencies” (top of the page) |
| **Users** | FX / treasury desk — compare hedged vs do-nothing carry across CCYs at forecast horizon Tf |
| **Stack visual** | Existing Cash Carry / VaR Analytics dark slate system (see style kit below) |

This section is the **portfolio entry point**: pick forecast Tf, scan all currencies, expand one CCY into its month cash schedule. Downstream sections (carry evolution, hedging summary, settle WAM modal) depend on the selected CCY.

---

## Current style kit (source of truth — extend, do not reinvent)

Shared chrome comes from `VarAnalyticsPanel` + `CashCarryAnalyticsView`. Treat these as locked patterns.

### Page / panel shell
```
/* Analytics panel wrapper */
space-y-5 rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-200

/* Page title (above Cash Carry sections) */
text-sm font-semibold text-white
mt-0.5 text-xs text-slate-500
```

### Section card (this block and siblings: carry evolution, hedging summary)
```
space-y-3 rounded-lg border border-slate-700 bg-slate-950/40 p-3
```

### Section header
```
/* Title micro-label */
text-[11px] font-semibold uppercase tracking-wide text-amber-200/90

/* Helper */
mt-0.5 text-[10px] text-slate-500

/* Header row layout */
flex flex-wrap items-start justify-between gap-3
```

### Segmented control (forecast period pills — same recipe app-wide)
```
/* Track */
inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5

/* Pill idle */
rounded-md px-2.5 py-1 text-[11px] font-semibold text-slate-500 hover:text-slate-300

/* Pill selected */
bg-emerald-500/20 text-emerald-100 shadow-sm

/* Disabled */
disabled:opacity-40
```

### Icon button (gear)
```
inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700
text-slate-400 hover:border-slate-500 hover:text-white
disabled:cursor-not-allowed disabled:opacity-40
/* icon size: h-3.5 w-3.5 */
```

### Aggregate / month tables
```
/* Scroll host */
overflow-x-auto

/* Table */
w-full min-w-[780px] text-left text-[10px]   /* month schedule uses min-w-[960px] */

/* Head */
text-slate-500 · th: py-1.5 pr-2 font-medium
/* Semantic head tints (keep): */
Residual → text-violet-300/80
FWD pts  → text-emerald-300/80
USD int  → text-sky-300/80
Do nothing → text-amber-200/80

/* Body row */
border-t border-slate-800/80 font-mono
idle: text-slate-300 hover:bg-slate-800/50 cursor-pointer
selected: bg-emerald-500/[0.12] text-slate-100
CCY cell: font-semibold text-white
hedged chip: ml-1 text-[9px] font-normal text-emerald-300/70
expand chevron: text-slate-500 (▸ / ▾)

/* Money cell colors (locked semantics) */
Opening          text-sky-300/90
Hedge CF         text-rose-300/80
Residual ≥0      text-violet-200   · <0 text-rose-300
FWD pts          text-emerald-300
USD int          text-sky-300
Total carry ≥0   font-semibold text-emerald-100 · <0 text-rose-300
Do nothing       text-amber-200/90
Δ ≥0             font-semibold text-emerald-100 · <0 text-rose-300

/* Footer “All CCY” */
border-t-2 border-slate-600 bg-slate-900/80 font-mono text-slate-200
```

### Number formats (do not change)
```
fmtK(usdM) → "+12.3K" / "−4.1K"   (usdM × 1000, 1 decimal)
fmtM(v)    → "+42.00M" / "−6.50M" (2 decimals)
Always show sign with ASCII + or Unicode −
```

### Expanded detail nested panel
```
space-y-3 rounded-md border border-emerald-500/30 bg-slate-950/70 p-3

/* Nested title */
text-[11px] font-semibold text-emerald-100

/* Collapse link */
text-[10px] text-slate-500 hover:text-slate-300
```

### Metric cards (5-up summary — reuse recipe)
```
grid gap-2 sm:grid-cols-3 lg:grid-cols-5

/* Card shell */
rounded border …/30 bg-…/10 px-2 py-1.5

/* Label */
text-[9px] font-semibold uppercase tracking-wide …/80

/* Value */
font-mono text-sm font-semibold

/* Accents already used */
Residual  border-violet-500/30  bg-violet-500/10  text-violet-200/80 → value violet-100
FWD       border-emerald-500/30 bg-emerald-500/10 text-emerald-200/80 → value emerald-100
USD int   border-sky-500/30     bg-sky-500/10     text-sky-200/80    → value sky-100
Total     border-amber-500/40   bg-amber-500/10   text-amber-200/80  → value amber-100
Δ         border-emerald-400/50 bg-emerald-500/15 text-emerald-100/90 → value emerald-100
```

### Cash-path chips (under metric cards)
```
flex flex-wrap gap-3 font-mono text-[11px]
label: text-slate-500
values: sky-300 / emerald-300/90 / rose-300/80 / amber-200/90
```

### Settle row highlight (month schedule)
```
bg-emerald-500/[0.06]
badge: text-[9px] font-normal text-emerald-300/80  (“settle” / “settle×N”)
```

### Empty / notice
```
py-4 text-center text-xs text-slate-500
/* status notice elsewhere: */
rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[10px] text-amber-100
```

### Radius / spacing rhythm (keep)
| Token | Value |
|-------|-------|
| Panel radius | `rounded-xl` |
| Section radius | `rounded-lg` |
| Nested / control radius | `rounded-md` |
| Section padding | `p-3` |
| Panel padding | `p-5` |
| Vertical stack | `space-y-3` / `space-y-4` / `space-y-5` |
| Control gap | `gap-2` / `gap-3` |
| Table type | `text-[10px]` mono body |

### Explicitly out of bounds (do not introduce)
- Light / cream / white primary backgrounds
- New brand fonts or Inter/serif display stacks
- Purple-indigo gradient consumer fintech chrome
- Soft multi-layer drop shadows / glow
- Rounded-full pill clusters as primary chrome (keep existing `rounded-md` pills in segmented track)
- Card grid replacing the aggregate table entirely
- Illustrations, emoji, decorative heroes
- Changing semantic color → metric mapping (violet=residual, emerald=FWD/Δ, sky=USD/opening, amber=do-nothing/total card, rose=outflow/neg)

---

## Job to be done

1. Set **forecast period Tf** (0 / 1 / 3 / 6 / 9 / 12 months) and optionally open **forecast profile** (flat / MoM / custom).
2. Scan **all FX book currencies** at Tf: opening cash, hedge cash-flows, carry split, total vs do-nothing, benefit.
3. Click a **CCY row** → expand **month schedule** for that dual cash book (FCY + USD after settles).
4. Keep reading density high — desk tool, not a marketing page.

---

## Current UI inventory (as shipped)

### Header strip
- Title: `Cash carry · all currencies` (uppercase amber micro-label)
- Helper: “Aggregated hedged carry @ Tf. Click a CCY row…”
- **Segmented control**: forecast periods — `0 month · 1 month · 3 months · 6 months · 9 months · 1 year`
- **Gear** button → forecast profile modal (disabled when Tf = 0)

### Aggregate table (dense, horizontal scroll, min-width ~780px)

| Col | Meaning | Format / color cue |
|-----|---------|-------------------|
| ▸/▾ | Expand | slate |
| CCY | Currency + optional `hedged` chip | white / emerald chip |
| Opening | Interest-bearing opening cash | sky, `fmtM` |
| Hedge CF | Σ hedge cash out (shown as −out) | rose |
| Residual int | Residual FCY overnight interest ($M) | violet |
| FWD pts | Swap-points carry accrued ($M) | emerald |
| USD int | Post-settle USD overnight ($M) | sky |
| Total carry | Hedged income Σ ($M) | emerald emphasis |
| Do nothing | Unhedged FCY interest ($M) | amber |
| Δ vs do nothing | Benefit of hedge ($M) | emerald / rose |

Footer row when ≥2 CCYs: **All CCY** totals (Opening / Hedge CF blank).

### Expanded detail (same section, below table)
Shown when a row is selected (`expandedCcy === chartCcy`):

1. **Summary metric cards** (5): Residual int · FWD pts · USD int · Total carry · Δ vs do nothing  
2. **Cash path chips**: Opening · Income Σ · Expenses Σ · Hedge CF · End FCY · End USD  
3. **Month schedule table** (min-width ~960px): Month · Start FCY · Income · Expenses · Hedge CF · End FCY · End USD · Residual int · FWD accrued · USD int · Income Σ  
   - Rows with settles get emerald tint + `settle` / `settle×N` badge  
4. **Collapse** control

Empty state: “No cash rows on the FX book…”

---

## Sample data (for mockups)

Use EUR-led multi-CCY book; numbers illustrative ($M):

| CCY | Opening | Hedge CF | Residual | FWD | USD int | Total | Do nothing | Δ |
|-----|---------|----------|----------|-----|---------|-------|------------|---|
| EUR | 42.0 | −18.5 | 0.12 | 0.85 | 0.41 | 1.38 | 0.95 | +0.43 |
| GBP | 8.2 | — | 0.04 | 0.00 | 0.00 | 0.04 | 0.04 | 0.00 |
| PLN | 15.0 | −6.0 | −0.02 | 0.22 | 0.11 | 0.31 | 0.18 | +0.13 |

Tf = **12 months** selected. EUR row expanded with 12 month rows; settles at M3/M6/M9/M12 highlighted.

---

## Pain points to fix (design focus)

1. **Dense spreadsheet feel** — 10 columns + tiny `10px` type; hard to scan “which CCY wins” at a glance.
2. **Primary metric buried** — Δ vs do-nothing and Total carry compete with mid-table splits.
3. **Period control crowded** — six tiny pills + gear fight the title on narrow widths (~676px content column).
4. **Expand pattern weak** — ▸/▾ + full second table feels bolted on; little hierarchy between summary and month path.
5. **Color overload** — violet / emerald / sky / amber / rose all at once without a clear legend.
6. **No visual comparison** — benefit is numeric only; no bar / spark / ranking cue across CCYs.
7. **Expanded schedule is wide** — second horizontal scroll inside an already scrolled page.
8. **Hedged state** is a tiny text chip; structure (bullet vs strip) not shown at portfolio level.

---

## Design goals

### Must keep (product / logic — do not invent new metrics)
- Forecast period control + gear entry to profile
- Same column semantics (Opening, Hedge CF, Residual, FWD, USD int, Total, Do nothing, Δ)
- Row click → CCY selection + expand month schedule
- All-CCY totals when multiple rows
- Settle-month highlighting in the schedule
- Dark theme compatible with surrounding Cash Carry page

### Should improve
- Clear **hero metrics** per row or for selected CCY (Total carry + Δ first)
- Progressive disclosure: summary → expand → month path
- Stronger selected / hedged / settle states
- Responsive layout for ~680px content width (stack period control, collapse secondary columns)
- Short legend for carry split colors
- Optional micro-viz: horizontal benefit bar or sparkline of month income (decorative OK if data-shaped)

### Nice to have
- Sticky table header / sticky CCY column
- Sort by Δ or Total (visual affordance only in mock)
- Bullet vs Strip badge on hedged rows
- Compact vs detailed table density toggle

---

## Visual constraints

Follow **Current style kit** above as the locked system. Refinement only:

- Reuse section card, segmented track, table mono `10px`, metric-card borders, emerald selected row
- Hierarchy improvements via weight / column order / spacing — not new chrome
- Metric cards already exist for expand state — strengthen, don’t replace with a different card language
- Motion: subtle expand / selected-row only

---

## Interaction model (preserve)

```
[Period pills] [Gear]
┌─────────────────────────────────────────────┐
│ CCY rows (click = select + expand)          │
│ … All CCY footer                            │
└─────────────────────────────────────────────┘
        ↓ if expanded
┌─────────────────────────────────────────────┐
│ CCY · month schedule @ Tf        [Collapse] │
│ [metric cards]                              │
│ [cash path chips]                           │
│ [month table with settle badges]            │
└─────────────────────────────────────────────┘
```

Clicking the same row again collapses. Selecting a row also sets `chartCcy` for charts below.

---

## Deliverables from Claude Design

Produce **1–2 high-fidelity dark mockups** (desktop ~1280 and narrow ~720 content):

1. **Collapsed portfolio** — multi-CCY table + period control, EUR hedged / GBP unhedged contrast  
2. **EUR expanded** — summary cards + month schedule with settle markers  

Optional third: empty state / Tf = 0 (opening cash only).

Also provide:
- Annotated callouts (what changed vs current)
- Suggested Tailwind-friendly spacing / type scale
- Column priority for responsive hide/show (e.g. hide Residual/FWD/USD int first; keep CCY, Total, Do nothing, Δ)

---

## Prompt for Claude Design

Copy below into Claude Design (include the style kit section from this file if the tool accepts attachments):

```
REFINE (do not redesign from scratch) an existing dark treasury analytics section: “Cash carry · all currencies”.

CRITICAL: Match the current UI system exactly. Do not invent a new visual language, light theme, new fonts, purple gradients, soft glows, rounded-full marketing pills, or card-dashboard replacement. This is a denser / clearer evolution of the same panel.

LOCKED STYLE (already in production — copy these patterns):
- Panel shell: rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-200
- Section: space-y-3 rounded-lg border border-slate-700 bg-slate-950/40 p-3
- Section title: text-[11px] font-semibold uppercase tracking-wide text-amber-200/90
- Helper: text-[10px] text-slate-500
- Segmented period control: track = rounded-lg border border-slate-700 bg-slate-950/60 p-0.5; idle pill = text-slate-500; selected = bg-emerald-500/20 text-emerald-100
- Gear: h-8 w-8 rounded-md border border-slate-700 text-slate-400
- Tables: text-[10px] font-mono, head text-slate-500, row border-t border-slate-800/80, hover bg-slate-800/50, selected row bg-emerald-500/[0.12]
- Money formats: +12.3K / −4.1K and +42.00M (always signed)
- Semantic colors (do not remap): Opening/USD sky; Hedge CF / negatives rose; Residual violet; FWD emerald; Do nothing amber; Total/Δ emerald emphasis; hedged chip emerald-300/70
- Expanded nest: rounded-md border border-emerald-500/30 bg-slate-950/70 p-3
- Metric cards: rounded border-*/30 bg-*/10 px-2 py-1.5; label text-[9px] uppercase; value font-mono text-sm (violet/emerald/sky/amber recipes already used)
- Settle months: bg-emerald-500/[0.06] + “settle” badge text-[9px] text-emerald-300/80
- Radii: xl panel / lg section / md controls — keep this rhythm

WHAT TO IMPROVE (layout & hierarchy only):
- Make Total carry + Δ vs do-nothing scan first without changing their meaning
- Reduce header crowding of period pills at ~680px width (same pill component)
- Stronger expand affordance while keeping ▸/▾ + nested emerald panel language
- Optional short legend using existing color tokens
- Responsive column priority (hide Residual/FWD/USD first; keep CCY, Total, Do nothing, Δ)
- Sample: EUR hedged Opening +42.00M with carry/Δ in +K format, GBP unhedged, PLN partial; Tf=12m; EUR expanded settles M3/M6/M9/M12

Deliver: 2 high-fidelity mockups that look like the SAME product (collapsed portfolio + EUR expanded), with callouts of what changed. If it wouldn’t drop into the current Tailwind class set, it’s wrong.
```

---

## Implementation notes (for after design)

| Item | Location |
|------|----------|
| React section | `CashCarryAnalyticsView.tsx` ~line “Cash carry · all currencies” |
| Row data | `multiCcyRows` / `multiCcyTotals` via `buildCashForecastCarryComparison` |
| Expand state | `expandedCcy` + `selectCcyRow` |
| Month schedule | `cashForecast` / `buildCashForecastSchedule` |
| Period options | `FORECAST_PERIOD_OPTIONS` |
| Do not change | Metric definitions / dual cash-book math in `lib/test-mode/cash-carry-analytics.ts` without FX desk sign-off |

When implementing a chosen mock: match structure and hierarchy; keep existing formatters (`fmtM`, `fmtK`) and selection side-effects (`setChartCcy`).
