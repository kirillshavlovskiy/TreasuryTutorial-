# Handoff: EUR — hedge carry profile (modal hierarchy refinement)

## Overview

A **refinement of the existing portal dialog** `{CCY} — hedge carry profile` in the Deel Treasury sandbox: `CashCarryAnalyticsView.tsx` (`profileOpen` → `createPortal`), with its nested `ExposureHedgePathChart` external performance host and `SettleWamDeltaVsBookChart`.

Scope: **chaptering, header meta, summary-card restraint, and ladder column order/weight**. No new components, colours, radii, fonts, or metric definitions. Everything below is expressible in the Tailwind class set already in the file.

## About the design files

`Hedge Carry Profile Modal.dc.html` (+ runtime `support.js`) is a **design reference authored in HTML**, not production code. It renders three annotated frames on one canvas; inline styles are an artifact of the authoring tool. Each frame has a small `i` button that opens its callouts.

`reference-current-modal.png` is the live modal screenshot the refinement was made against. `original-brief.md` holds the full locked style kit, product context, and pain-point list.

Implement by editing the modal JSX in `CashCarryAnalyticsView.tsx` (and the label rendering in `SettleWamDeltaVsBookChart`); do not port inline styles.

## Fidelity

**High-fidelity.** Every hex in the mock maps to a production Tailwind token — mapping table at the bottom. Implement with the class, never the hex.

## Frames

| Id | Frame | Content width |
|----|-------|---------------|
| `1a` | Wide — full stack, sticky header, all four chapters | ~1024 |
| `1b` | Scrolled to the ladder — reordered/weighted columns, sticky first column | ~1024 |
| `1c` | Narrow — chips wrap, summary stacks 2-up, ladder reduced to three columns | ~720 |

---

## Change 1 — Sticky header + meta chips

Panel keeps `max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl`.

- Wrap title + Close in a sticky bar: `sticky top-0 z-10 -mx-4 -mt-4 bg-slate-900 px-4 pb-2.5 pt-4 border-b border-slate-800/80`. Title and Close classes unchanged (`text-sm font-semibold text-white`; `rounded border border-slate-600 px-2 py-1 text-xs text-slate-300`).
- Replace the run-on `text-[11px] text-slate-400` meta sentence with four chips in a `flex flex-wrap items-center gap-1.5` row. Chip shell: `inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950/60 px-1.5 py-0.5 text-[11px] text-slate-500`, with the value `font-semibold` in its existing tint:

| Chip | Value class |
|---|---|
| Structure | `text-violet-200` |
| Skew | `text-amber-200/90` |
| Book WAM | `text-emerald-200` |
| Schedule | `font-mono text-amber-200/90` |

Chips wrap at narrow widths (frame `1c`) instead of truncating.

## Change 2 — Chapters

Four chapters, separated by nothing more than a label above each existing section card:

`text-[9px] font-semibold uppercase tracking-wide text-slate-600` → `1 · Summary`, `2 · Performance & setup`, `3 · Settle WAM`, `4 · Hedge path`. Body gap `space-y-3.5`.

The performance host (`pathPerfPanelHost`) gets wrapped in the same `rounded-lg border border-slate-700 bg-slate-950/40 p-3` section card as its neighbours, so it stops floating between chapters. Everything portaled into it is unchanged.

## Change 3 — Summary cards: one primary accent

Grid becomes `grid gap-2 sm:grid-cols-2 lg:grid-cols-6`, with the hero card `lg:col-span-2` and the four existing cards one column each.

**New hero card — Enhancement @ book WAM.** Not a new metric: it is `settleWamScenarios` at the book row, already computed for the ladder.

```
shell: rounded border border-emerald-700/40 bg-emerald-950/30 px-2.5 py-1.5
label: text-[9px] font-semibold uppercase tracking-wide text-emerald-400/80
       → "Enhancement @ book WAM · M9"
value: font-mono text-lg font-semibold text-emerald-100   → "+294.6K"
vs:    font-mono text-[11px] text-sky-200                 → "vs book —"
sub:   mt-0.5 text-[9px] text-emerald-200/70
       → "Best M5 +302.4K · +7.8K vs book · band 15.6K"
```

Negative Enhancement uses `text-rose-300` as elsewhere. The "best" figures come from `max`/spread over the same scenario array — derive inline, do not store.

**The four existing cards go neutral:** `rounded border border-slate-700 bg-slate-900/60 px-2.5 py-1.5`, label `text-[9px] font-semibold uppercase tracking-wide text-slate-500`, value `font-mono text-sm font-semibold text-slate-100` (Cover, Legs) / `text-slate-300` (Resid VaR, Breakeven), sub `mt-0.5 text-[9px] text-slate-500`. Resid VaR still switches to `text-rose-300` when non-zero; the emerald / blue / red / amber shells are dropped so only the hero reads as primary.

## Change 4 — Settle WAM chart

Series, click-to-apply, book marker on its true Y, and amber rings on proposed months are all unchanged. Two presentation additions:

- **Marker legend** above the chart, `flex flex-wrap items-center gap-2.5 text-[10px] text-slate-500`, each item `inline-flex items-center gap-1.5` with an `inline-block h-2 w-2 rounded-full` swatch: `bg-emerald-200` Selected settle WAM · `bg-emerald-500 ring-2 ring-amber-500` Proposed strip month · `bg-emerald-600` Click to apply.
- Chart header carries a mono context line `font-mono text-[10px] text-slate-500` — "selected ≈ M9 · proposed M6/M12" — instead of repeating structure/schedule prose already in the header chips. Trim the helper paragraph to one line.

**Axis labels must share the plot's coordinate space.** In the mock the month labels are absolutely positioned at each point's own x as a percentage. In `SettleWamDeltaVsBookChart`, render them as `<text text-anchor="middle">` at the point x inside the SVG (or absolutely position them from the same x scale) — a parallel `grid-cols-13` row drifts against the points and breaks the click-to-apply read. Label emphasis: book month `font-semibold text-emerald-200`, proposed months `font-semibold text-amber-200/90`, others `text-slate-500`.

## Change 5 — WAM ladder column order and weight

**Current:** Settle WAM · Struct · Hedge Δ · Schedule · Default (Old) · FCY int · USD int · New · FWD pts · Enhancement · Total · vs book

**New:** Settle WAM · **Enhancement · vs book** · │ · Struct · Hedge Δ · Schedule · Default (Old) · FCY int · USD int · New · FWD pts · Total

- Every column, formatter, and colour survives — only position and weight change.
- Group header row in the same `<thead>`: `text-[9px] font-semibold uppercase tracking-wide text-slate-600`, `colSpan={2}` "Outcome" and `colSpan={9}` "Setup & carry split" with `border-l border-slate-800 pl-3`.
- `Enhancement` and `vs book` values become `text-[11px] font-semibold` (`text-emerald-100` / `text-sky-200`, `text-rose-300` when negative, `—` in `text-slate-500` on the book row). The split group stays `text-[10px]`.
- Add `border-l border-slate-800 pl-3` to the `Struct` cell in head, body, and footer.
- Head tints follow the moved columns: `Enhancement` `text-emerald-200/80`, `vs book` `text-sky-200/80`, `Struct` and `FCY int` `text-violet-300/80`, `Default (Old)` `text-amber-200/80`, `USD int` `text-sky-300/80`, `FWD pts` `text-emerald-300/80`.
- `min-w-[920px]` → `min-w-[980px]`.

**Sticky first column.** `Settle WAM` th/td get `sticky left-0`. They need an opaque background, and it must match the composited section colour or the column reads as a dark stripe: the section is `bg-slate-950/40` over `bg-slate-900`, i.e. `rgb(10,16,34)`; the book row adds `emerald-500/8%` → `rgb(11,30,42)`. Cleanest production fix: make the ladder's own wrapper opaque (`bg-[#0a1022]`-equivalent via an opaque slate-950/900 blend, or drop the `/40` on that one card) so the sticky cells can use the same solid class as the card. Do **not** hard-code `slate-950` there.

Row states unchanged: book `bg-emerald-500/[0.08]`, beyond Tf `opacity-50`, `hover:bg-slate-800/50`, click applies WAM. `book` / `prop` / `>Tf` chips keep `text-[9px] font-normal` in `text-emerald-300/80` / `text-amber-200/90`.

## Change 6 — Show / Hide ladder

A control beside the section title: `rounded-md border border-slate-700 bg-slate-950/60 px-2 py-0.5 text-[10px] font-semibold text-slate-300`, toggling "Show ladder" / "Hide ladder" so the chart alone can hold the fold. Local `useState` only — it must not touch the prepared package or schedule.

## Change 7 — Narrow (~720)

- Hero card full width; the four neutral cards fall to `grid-cols-2`.
- Ladder reduces to **Settle WAM · Enhancement · vs book**, with `Struct · schedule` as a `mt-0.5 text-[9px] font-normal text-slate-500` sub-line under the month. Gate the dropped columns with `hidden md:table-cell` so the full ladder returns above ~840px.
- Note under the table, `text-[10px] text-slate-500`: "Default (Old) · FCY int · USD int · New · FWD pts · Total stay in the expanded ladder above ~840px."
- No mobile nav, no new shell — the same dialog at a smaller content width.

## Change 8 — Hedge path stays last

Chapter 4 keeps `ExposureHedgePathChart` with `summaryMetricsPlacement="none"` exactly as shipped (the mock shows the two charts as grey placeholders). It is kept below the WAM chapter so the settle decision is made before the path is inspected.

---

## Must not change

- Metric math: Enhancement (New − Old + FWD), vs book, Old/New definitions, `buildSettleWamScenarios`
- `fmtK` / `fmtM` always-signed output (`+12.3K`, `+16.30M`)
- Click-to-apply WAM (`applySettleWamScenario` / `applySettleWamToPrepared`) and gear schedule sync
- External performance host wiring and the gear's structure / regime / schedule / CoM controls
- Dialog shell classes, `max-w-5xl`, `90vh` scroll, backdrop dismiss
- Semantic map: violet = structure / FCY, amber = skew / schedule / do-nothing, emerald = Enhancement / FWD / book, sky = USD / vs book, rose = negatives
- Radii: `rounded-xl` dialog / `rounded-lg` section / `rounded-md` controls / `rounded` cards

## Sample data in the mocks

EUR · Strip · 2 legs · Skew Neutral · Book WAM **M9** · schedule **M6/M12** · Cover `+16.30M` 100% · Resid VaR `$0K` · Breakeven `M4.2`.

Enhancement by settle month ($K): M0 291.4 · M1 286.8 · M2 293.1 · M3 299.6 · M4 299.2 · M5 302.4 · M6 297.7 · M7 295.9 · M8 301.5 · **M9 294.6 (book)** · M10 296.2 · M11 300.1 · M12 288.4. Proposed rings on M6 / M12.

Ladder splits are generated so each row is internally consistent with `Enhancement = New − Old + FWD` (Old held at `+118.4K`); production values come from `buildSettleWamScenarios`. Tick-trade rows (M0–M3 / M0–M7 / M0–M12) are copied from the reference screenshot.

## Hex → Tailwind mapping

| Hex / rgba | Class |
|---|---|
| `#0f172a` | `slate-900` (panel `bg-slate-900`) |
| `rgba(2,6,23,.4)` / `rgba(2,6,23,.6)` / `#020617` | `bg-slate-950/40` · `bg-slate-950/60` · `slate-950` |
| `rgba(15,23,42,.6)` | `bg-slate-900/60` |
| `rgba(30,41,59,.8)` / `#1e293b` | `border-slate-800/80` · `slate-800` |
| `#334155` / `#475569` / `#64748b` | `slate-700` · `slate-600` · `slate-500` |
| `#94a3b8` / `#cbd5e1` / `#f1f5f9` | `slate-400` · `slate-300` · `slate-100` |
| `rgba(4,120,87,.4)` / `rgba(2,44,34,.3)` | `border-emerald-700/40` · `bg-emerald-950/30` |
| `rgba(52,211,153,.8)` / `#a7f3d0` / `#d1fae5` / `#6ee7b7` / `#34d399` / `#10b981` / `#059669` | `emerald-400/80` · `emerald-200` · `emerald-100` · `emerald-300` · `emerald-400` · `emerald-500` · `emerald-600` |
| `rgba(16,185,129,.08)` | `bg-emerald-500/[0.08]` (book row) |
| `#ddd6fe` / `#c4b5fd` / `rgba(196,181,253,.8)` | `violet-200` · `violet-300` · `violet-300/80` |
| `#bae6fd` / `#7dd3fc` / `#0ea5e9` | `sky-200` · `sky-300` · `sky-500` |
| `rgba(253,230,138,.9)` / `rgba(245,158,11,.12)` / `#f59e0b` | `amber-200/90` · `bg-amber-500/10` · `amber-500` |
| `#fda4af` | `rose-300` |
| `rgba(0,0,0,.6)` + blur | `bg-black/60 backdrop-blur-sm` |
| `4/6/8/12px` radius | `rounded` · `rounded-md` · `rounded-lg` · `rounded-xl` |
| `9/10/11/14/18px` type | `text-[9px]` · `text-[10px]` · `text-[11px]` · `text-sm` · `text-lg` |

Numbers are `font-mono`; no new fonts.

## Assets

None. The gear glyph is the existing `GearIcon` in `ExposureHedgePathChart.tsx`. Chart markers are plain SVG circles as shipped.

## Files in this bundle

- `Hedge Carry Profile Modal.dc.html` — three annotated frames (open in a browser; `support.js` must sit alongside)
- `support.js` — runtime for the mock
- `reference-current-modal.png` — the live modal this refines
- `original-brief.md` — locked style kit, product context, pain points
- Implementation targets: `CashCarryAnalyticsView.tsx` (modal JSX), `SettleWamDeltaVsBookChart` (axis labels only)
