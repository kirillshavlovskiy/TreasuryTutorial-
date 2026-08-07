# Handoff: Cash carry · all currencies — hierarchy refinement

## Overview

A **refinement of one existing section** in the Deel Treasury sandbox: the "Cash carry · all currencies" block at the top of `components/test-mode/CashCarryAnalyticsView.tsx` (Analytics → Cash Carry tab).

It is the portfolio entry point for the FX/treasury desk: pick forecast period Tf, scan every book currency's hedged carry vs do-nothing, click a CCY row to expand that book's month cash schedule.

Scope of the change is deliberately narrow: **hierarchy, column order, weight, spacing, and colour restraint**. No new components, no new colours, radii, or type sizes. Everything is expressible in the Tailwind class set already used in the file.

## About the design files

`Cash Carry All Currencies.dc.html` (+ its runtime `support.js`) is a **design reference created in HTML**, not production code. It renders three annotated mock frames on one canvas; it uses inline styles because of the tool it was authored in.

The task is to **apply the documented hierarchy changes to the real React/Tailwind component** — `CashCarryAnalyticsView.tsx` — using the existing Tailwind classes listed below. Do not port inline styles, and do not restructure the component beyond the JSX inside the first `<section>`.

`original-brief.md` is the source brief with the full locked style kit and product context.

## Fidelity

**High-fidelity.** Colours, type sizes, spacing, and radii are exactly the production tokens. Every inline hex in the mock maps 1:1 to a Tailwind class (mapping table at the bottom) — implement with the class, never the hex.

## What must not change

- Metric definitions and dual cash-book math (`lib/test-mode/cash-carry-analytics.ts`)
- Formatters `fmtM` / `fmtK` and their always-signed output (`+42.00M`, `−4.1K`)
- Semantic colour map: violet = residual, emerald = FWD / Total / Δ, sky = USD & opening, amber = do-nothing, rose = outflows / negatives
- Selection side effects: row click sets `chartCcy` and toggles `expandedCcy`; clicking the same row collapses
- Radius rhythm: `rounded-xl` panel / `rounded-lg` section / `rounded-md` nested & controls / `rounded` metric cards
- Table body type stays `text-[10px] font-mono`

## Frames in the file

| Id | Frame | Width |
|----|-------|-------|
| `1a` | Collapsed portfolio, EUR/GBP/PLN | 1240px content |
| `1b` | EUR expanded — metric cards, cash-path chips, 12-month schedule | 1240px content |
| `1c` | Narrow layout | 720px content |

---

## Change 1 — Aggregate table column order

**Current order:** ▸ · CCY · Opening · Hedge CF · Residual int · FWD pts · USD int · Total carry · Do nothing · Δ vs do nothing

**New order:** ▸ · CCY · **Total carry · Do nothing · Δ vs do nothing** · │ · Opening · Hedge CF · Residual int · FWD pts · USD int

The outcome trio moves directly after CCY so "which CCY wins" is answered in the first three number columns. The cash/carry split moves right, behind a divider.

Implementation notes:

- Reorder the `<th>`s and the matching `<td>`s. Column semantics, formatters, and conditional colour classes are unchanged — they just move.
- Add a **group header row** above the existing head row, same `<thead>`, styled with existing tokens:
  - `text-[9px] font-semibold uppercase tracking-wide text-slate-600`
  - Cell 1: empty (chevron), cell 2: empty (CCY)
  - `colSpan={3}` → `Outcome @ Tf ($K)`, right-aligned
  - `colSpan={5}` → `Cash & carry split`, right-aligned, with `border-l border-slate-800 pl-3`
- Add `border-l border-slate-800 pl-3` to the **Opening** cell in the head row, every body row, and the footer (the footer's `Opening`/`Hedge CF` cell is the existing `colSpan={2}` em-dash cell).
- All numeric cells become `text-right` (heads too). Keep `font-mono` on the row.
- Head tints follow the moved columns: `Total carry` and `Δ vs do nothing` heads get `text-emerald-200/80`, `Do nothing` keeps `text-amber-200/80`, `Residual int` `text-violet-300/80`, `FWD pts` `text-emerald-300/80`, `USD int` `text-sky-300/80`.

## Change 2 — Weight split between hero and split columns

- `Total carry`, `Δ vs do nothing` values: `text-[11px] font-semibold` (colour logic unchanged: `text-emerald-100` when ≥ 0, `text-rose-300` when < 0).
- A Δ of exactly zero reads `text-slate-500` instead of emerald, so a no-benefit currency (GBP) does not look like a win.
- Split columns stay `text-[10px]` with their existing per-metric colours.
- Em-dashes for absent values are `text-slate-600`.
- Footer `All CCY` row: only `Total carry` and `Δ` get the `text-[11px] font-semibold text-emerald-100` treatment.

## Change 3 — Δ micro-bar

Inside the Δ cell, stacked under the number (`flex flex-col items-end gap-[3px]`):

```
track: block h-0.5 w-16 rounded-sm bg-slate-700/70
fill:  block h-0.5 rounded-sm bg-emerald-400/85, width = |Δ| / max|Δ| across rows
```

Zero Δ renders the track only. Decorative but data-shaped; drop it if the desk does not want it — nothing else depends on it.

## Change 4 — Header crowding at ~680–720px

At narrow widths (frame `1c`) the header stacks instead of using `justify-between`:

1. Title micro-label + helper on their own row.
2. A second row with the **same** segmented track (`inline-flex flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5`) and the gear button, `justify-between`.
3. Pill labels shorten to `0m 1m 3m 6m 9m 1y` at that breakpoint. Same pill classes.

Tailwind-only approach: keep the current single flex container and let it wrap — `flex-col gap-3 sm:flex-row sm:items-start sm:justify-between` on the header row, and render the short label with `<span className="sm:hidden">3m</span><span className="hidden sm:inline">3 months</span>` (or a `shortLabel` on `FORECAST_PERIOD_OPTIONS`).

## Change 5 — Responsive column priority

Hide in this order as width shrinks; never hide CCY, Total carry, Do nothing, Δ:

1. `USD int`, `FWD pts`, `Residual int` — `hidden lg:table-cell`
2. `Hedge CF`, `Opening` — `hidden md:table-cell`

When Opening/Hedge CF are hidden, they appear as a sub-line inside the CCY cell:

```
mt-0.5 text-[9px] font-normal text-slate-500   →   "+42.00M · CF −18.50M"
```

Wrapped in `md:hidden`. With those columns hidden the table no longer needs `min-w-[780px]` at 720px — gate the min-width (`md:min-w-[780px]`) so the narrow layout has no horizontal scroll.

Also add a one-line note under the table at narrow widths: `text-[10px] text-slate-500` — "Residual int · FWD pts · USD int collapse into the expanded panel below ~840px."

## Change 6 — Selected-row and expand affordance

- Selected row keeps `bg-emerald-500/[0.12] text-slate-100`.
- The chevron cell on the selected row goes `text-emerald-300` (idle stays `text-slate-500`). `▾` / `▸` glyphs unchanged.
- No other new state chrome.

## Change 7 — Expanded panel colour restraint

The nested panel keeps `space-y-3 rounded-md border border-emerald-500/30 bg-slate-950/70 p-3`. Colour is reduced so one thing reads as primary:

**Metric cards** — order becomes **Δ vs do nothing · Total carry · Residual int · FWD pts accrued · USD int**.

- Δ card keeps its accent: `rounded border border-emerald-500/40 bg-emerald-500/10`, label `text-[9px] font-semibold uppercase tracking-wide text-emerald-200/80`, value `font-mono text-sm font-semibold text-emerald-100`.
- The other four go neutral: `rounded border border-slate-700 bg-slate-900/60`, label `text-[9px] font-semibold uppercase tracking-wide text-slate-500`, value `font-mono text-sm font-semibold` — `text-slate-100` for Total carry, `text-slate-300` for the three split cards. Negative values still fall back to `text-rose-300`.
- Grid stays `grid gap-2 sm:grid-cols-3 lg:grid-cols-5`.

**Cash-path chips** — labels stay `text-slate-500`; values go `text-slate-300` (Opening, Income Σ) and `text-slate-100` (End FCY, End USD). Only the two outflows keep colour: Expenses Σ and Hedge CF stay `text-rose-300/80`.

**Nested title** gains a mono sub-line beside it: `font-mono text-[10px] text-slate-500` — "12m · 4 settles · strip" (derived from Tf, settle count, and `prepared.structure`). Collapse control unchanged.

## Change 8 — Month schedule table

- Same `border-l border-slate-800 pl-3` divider before `Residual int`, and all numeric columns right-aligned.
- Cash columns (`Start`, `Income`, `Expenses`, `Hedge CF`, `End FCY`, `End USD`) are **neutral**: `text-slate-300` / `text-slate-100` — the row's cash path should read as one block, not five hues.
- Carry columns keep their semantic colours: Residual `text-violet-200`, FWD `text-emerald-300`, USD int `text-sky-300`, Income Σ `font-semibold text-emerald-100`.
- **New column: `Enhancement`**, last, head `text-emerald-200/80`. Per-month value = that month's income (`residual + fwd + usdInt`) minus that month's do-nothing accrual. `fmtK`, `font-semibold`, `text-emerald-100` when ≥ 0, `text-rose-300` when < 0. Footer cell = the CCY's `hedgeVsNoHedgeUsdM`. This is a presentation of existing numbers — if a matching per-month do-nothing series is not already available from `buildCashForecastSchedule`, add it there rather than deriving it in the view.
- Settle rows keep `bg-emerald-500/[0.06]` plus the `settle` / `settle×N` badge (`text-[9px] font-normal text-emerald-300/80`).
- Footer `Total @ Tf` row: the `colSpan={7}` label cell is unchanged; split totals go `text-slate-200 font-semibold`, Income Σ and Enhancement keep `text-emerald-100`.
- `min-w-[960px]` becomes `min-w-[1040px]` with the extra column.

## Change 9 — Optional legend

Under the aggregate table, `flex flex-wrap items-center gap-3 text-[10px] text-slate-500`, each item `inline-flex items-center gap-1.5` with an `inline-block h-2 w-2 rounded-sm` swatch:

`bg-violet-500` Residual FCY int · `bg-emerald-500` FWD pts · `bg-sky-500` USD int / opening · `bg-amber-500` Do nothing · `bg-rose-500` Cash out

Same pattern as the existing `CarryEvolutionBarChart` legend. Gate it behind a prop or a constant so it can be turned off.

---

## Interactions & behaviour (unchanged from production)

- Period pill click → `onForecastMonthsChange(opt.months)`; selected = `forecastPeriodIdForMonths(setup.forecastMonths)`.
- Gear → `onOpenForecastProfile()`, disabled when `setup.forecastMonths === 0` or the handler is absent.
- Row click / Enter / Space → `selectCcyRow(ccy)`; same row again collapses. Rows keep `role="button" tabIndex={0} cursor-pointer`.
- Row hover (unselected) → `hover:bg-slate-800/50`. `transition-colors` only; no new motion.
- Footer `All CCY` row renders when `multiCcyRows.length > 1`.
- Empty states: `py-4 text-center text-xs text-slate-500` "No cash rows on the FX book…"; Tf = 0 inside the expanded panel → `text-[10px] text-slate-500` "Tf = 0 — opening cash only."

## State

No new state. Existing `chartCcy`, `expandedCcy`, `detailOpen`, and the `multiCcyRows` / `cashForecast` / `carryComparison` memos cover everything. The Δ micro-bar needs `max(|benefitUsdM|)` across `multiCcyRows` — derive it inline from the memo, do not store it.

## Sample data used in the mocks

Tf = 12 months; EUR expanded with settles at M3/M6/M9/M12.

| CCY | Opening | Hedge CF | Residual | FWD | USD int | Total | Do nothing | Δ |
|-----|---------|----------|----------|-----|---------|-------|------------|---|
| EUR (hedged) | +42.00M | −18.50M | +120.0K | +850.0K | +410.0K | +1380.0K | +950.0K | +430.0K |
| GBP | +8.20M | — | +40.0K | — | — | +40.0K | +40.0K | +0.0K |
| PLN (hedged) | +15.00M | −6.00M | −20.0K | +220.0K | +110.0K | +310.0K | +180.0K | +130.0K |
| **All CCY** | — | — | +140.0K | +1070.0K | +520.0K | +1730.0K | +1170.0K | +560.0K |

EUR month schedule: income +3.20M/mo, expenses −1.10M/mo, hedge CF −4.625M at each settle, USD +5.04M received per settle. Illustrative only — production numbers come from `buildCashForecastSchedule`.

## Hex → Tailwind mapping

Use the class, not the hex. The mock's inline styles resolve as:

| Hex / rgba | Class |
|---|---|
| `#020617`, `rgba(2,6,23,.4/.6/.7)` | `slate-950`, `bg-slate-950/40` `/60` `/70` |
| `#0f172a`, `rgba(15,23,42,.6/.8)` | `slate-900`, `bg-slate-900/60` `/80` |
| `#1e293b`, `rgba(30,41,59,.5/.8)` | `slate-800`, `bg-slate-800/50`, `border-slate-800/80` |
| `#334155`, `rgba(51,65,85,.7)` | `slate-700`, `bg-slate-700/70` |
| `#475569` | `slate-600` |
| `#64748b` | `slate-500` |
| `#94a3b8` | `slate-400` |
| `#cbd5e1` | `slate-300` |
| `#e2e8f0` | `slate-200` |
| `#f1f5f9` | `slate-100` |
| `#d1fae5` / `#a7f3d0` / `#6ee7b7` / `rgba(52,211,153,.85)` / `#10b981` | `emerald-100` / `200` / `300` / `bg-emerald-400/85` / `emerald-500` |
| `#ede9fe` / `#ddd6fe` / `#c4b5fd` / `#8b5cf6` | `violet-100` / `200` / `300` / `500` |
| `#e0f2fe` / `#bae6fd` / `#7dd3fc` / `#0ea5e9` | `sky-100` / `200` / `300` / `500` |
| `#fef3c7` / `#fde68a` / `#f59e0b` | `amber-100` / `200` / `500` |
| `#fda4af` / `#f43f5e` | `rose-300` / `rose-500` |
| `4px` / `6px` / `8px` / `12px` radius | `rounded` / `rounded-md` / `rounded-lg` / `rounded-xl` |
| `9px` / `10px` / `11px` / `14px` type | `text-[9px]` / `text-[10px]` / `text-[11px]` / `text-sm` |
| `2px` / `4px` / `6px` / `8px` / `12px` / `20px` spacing | `p-0.5` / `1` / `1.5` / `2` / `3` / `5` (and `gap-*` equivalents) |

Numbers use `ui-monospace` → `font-mono`. Everything else inherits the app's sans stack; no new fonts.

## Assets

None. The gear glyph is the existing `GearIcon` in `CashCarryAnalyticsView.tsx` (`h-3.5 w-3.5`). Chevrons are the literal `▸` / `▾` characters. No images, no new icon dependency.

## Files in this bundle

- `Cash Carry All Currencies.dc.html` — the three annotated mock frames (open in a browser; `support.js` must sit alongside it)
- `support.js` — runtime for the mock file
- `original-brief.md` — source brief with the full production style kit, product context, and pain-point list
- Target for implementation (in the app repo): `components/test-mode/CashCarryAnalyticsView.tsx`, first `<section>` only
