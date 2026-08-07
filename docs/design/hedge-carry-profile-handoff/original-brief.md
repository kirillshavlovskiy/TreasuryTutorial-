# Claude Design brief — Hedge carry profile modal

> Paste this file (or the **Prompt for Claude Design** section) into Claude Design / Claude Artifacts.
> Implementation: `CashCarryAnalyticsView.tsx` portal dialog (`profileOpen` → `createPortal`) + nested
> `ExposureHedgePathChart` (external performance host) + `SettleWamDeltaVsBookChart`.
>
> **Style rule:** This is a **refinement of the existing modal**, not a greenfield redesign.
> Reuse the dialog chrome, metric-card recipes, section cards, dense mono tables, and semantic
> colours below. Improve hierarchy / scanability / crowding — do **not** invent a new visual
> language, light theme, or alternate component kit.
>
> Pair with a **screenshot** of the live modal (EUR strip preferred).

---

## Product context

| | |
|---|---|
| **App** | Deel Treasury sandbox — FX Cash Carry analytics |
| **Surface** | Analytics → Cash Carry → Hedging summary → click CCY row |
| **Component** | `CashCarryAnalyticsView` modal (`z-[200]` portal) |
| **Title** | `{CCY} — hedge carry profile` (e.g. `EUR — hedge carry profile`) |
| **Users** | FX desk — size strip/bullet cover, pick settle WAM, read Enhancement vs do-nothing / vs book |
| **Opens from** | Hedging summary table row (`openCcyProfile`) |
| **Closes** | Close button, backdrop click |

This modal is the **analytical workspace for one CCY**: summary cards → tick-trades / performance (portaled from hedge path) → Settle WAM chart + ladder table → hedge-path charts (Resid VaR + Exposure) with gear for structure / schedule / CoM.

---

## Job to be done

1. See **cover / legs / resid VaR / breakeven** at a glance for the prepared package.
2. Edit **structure** (Bullet / Strip), **regime**, **settle schedule** (gear on hedge path — Cash Carry external mode).
3. Compare **settle WAM** scenarios on Enhancement curve; click a point / table row to restage prepared + schedule.
4. Confirm **book WAM**, schedule label (`M6/M12`), skew, and Enhancement vs book.
5. Keep desk density — modal is already max-w-5xl / 90vh scroll; hierarchy must reduce scroll hunting.

---

## Current UI inventory (as shipped)

### Dialog chrome
```
Backdrop: fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm
Panel:    max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl
```

### Header
- Title: `text-sm font-semibold text-white` — `{CCY} — hedge carry profile`
- Meta line: `text-[11px] text-slate-400`
  - Structure → `font-semibold text-violet-200` (`Strip · N` / `Bullet`)
  - Skew (strip) → `font-semibold text-amber-200/90` (Front / Back / Neutral)
  - Book WAM → `font-semibold text-emerald-200` + schedule `font-mono text-amber-200/90`
- Close: `rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800`

### Block A — Summary metric cards (`pathSummaryMetrics`, 4-up)
```
grid gap-2 sm:grid-cols-4
card: rounded border …/40 bg-…/30 px-2 py-1.5
label: text-[9px] uppercase …
value: font-mono text-sm font-semibold
sub:   mt-0.5 text-[9px] …/60|/70
```

| Card | Border / bg | Label tint | Value |
|------|-------------|------------|-------|
| Cover (STRIP COVER · TARGET …) | emerald-700/40 · emerald-950/30 | emerald-400/80 | emerald-200 (+ pct emerald-300/90) |
| Strip legs | blue-700/40 · blue-950/30 | blue-400/80 | blue-200 |
| Resid VaR | red-700/40 · red-950/30 | red-400/80 | red-200 |
| Breakeven | amber-700/40 · amber-950/30 | amber-400/80 | amber-200 |

Sample (EUR strip): Cover `+16.30M` `100%` · Legs `2` · Resid VaR `$0K` · Breakeven as computed.

### Block B — Performance · tick-trades host
```
<div ref={setPathPerfPanelHost} className="min-h-0" />
```
Content portaled from `ExposureHedgePathChart` (`performancePanelPlacement="external"`): gear (structure / regime / schedule / CoM·kurtosis), tick-trade table. **Same slate / emerald / violet control language as Cash Carry page.**

### Block C — Settle WAM · Enhancement section
```
section: space-y-3 rounded-lg border border-slate-700 bg-slate-950/40 p-3
title:   text-[11px] font-semibold text-emerald-200
helper:  text-[10px] text-slate-500
```

1. **`SettleWamDeltaVsBookChart`** — SVG line of absolute Enhancement vs settle month; book marker; amber rings = proposed schedule months; click applies WAM.
2. **Scenario ladder table** — `min-w-[920px] text-[10px] font-mono`

| Col | Cue |
|-----|-----|
| Settle WAM | white + `book` / `>Tf` chips |
| Struct | violet-300/90 |
| Hedge Δ | slate-300 · fmtM |
| Schedule | slate-400 |
| Default (Old) | amber-200/90 |
| FCY int | violet-300/90 |
| USD int | sky-300 |
| New | white |
| FWD pts | emerald-300 |
| Enhancement | emerald-100 / rose (hero) |
| Total | slate-300 |
| vs book | sky-200 / rose · `—` on book row |

Row states: book `bg-emerald-500/[0.08]`; beyond Tf `opacity-50`; clickable hover `hover:bg-slate-800/50`.

### Block D — Hedge path (below fold)
`ExposureHedgePathChart` with `summaryMetricsPlacement="none"` — Resid VaR profile + Exposure profile only (gear holds structure/schedule). Same chart chrome as FX Risk path, Cash Carry mode.

---

## Current style kit (locked — extend, do not reinvent)

### Shared with Cash Carry page
- Section card: `rounded-lg border border-slate-700 bg-slate-950/40 p-3`
- Tables: `text-[10px] font-mono`, head `text-slate-500`, row `border-t border-slate-800/80`
- Money: `fmtK` → `+12.3K` / `fmtM` → `+16.30M` (always signed)
- Semantic map: violet = structure / FCY; amber = skew / schedule / do-nothing; emerald = Enhancement / FWD / book; sky = USD / vs book; rose = negative / outflows
- Radii: `rounded-xl` dialog · `rounded-lg` section · `rounded-md` controls · `rounded` metric cards
- Segmented pills (inside gear / path): track `border-slate-700 bg-slate-950/60 p-0.5`; selected `bg-emerald-500/20 text-emerald-100`

### Modal-specific tokens
```
backdrop blur + black/60 overlay
panel shadow-2xl (keep — dialog affordance)
summary cards use emerald / blue / red / amber tinted shells (do not replace with random new hues)
book row highlight = emerald-500/[0.08] (same family as aggregate selected row)
Hedging summary opener row uses violet hover/selected — modal header structure stays violet
```

### Explicitly out of bounds
- Light / cream modal skins
- New fonts or display serifs
- Purple-indigo gradient consumer chrome / glow stacks
- Replacing the WAM ladder with a card gallery
- Changing Enhancement / vs-book / Old / New definitions
- Removing click-to-apply WAM or gear schedule sync
- Rounded-full marketing CTAs

---

## Pain points to fix (design focus)

1. **Long scroll** — cards → perf → chart → 12-col table → path charts; hard to see “what matters” without hunting.
2. **Header meta is a run-on sentence** — Structure · Skew · Book WAM · schedule competes with title.
3. **Four tinted summary cards** are equally loud (emerald/blue/red/amber) — no primary outcome.
4. **WAM table is 12 columns** at `10px` — Enhancement / vs book buried after Default/FCY/USD/New/FWD.
5. **Chart + table + path** repeat structure/schedule context already in the header.
6. **Perf host + gear** can look disconnected from Settle WAM block (no visual chaptering).
7. **~894×674 viewport** (user sample) — max-w-5xl content still feels cramped; needs better fold priority, not a wider shell.

---

## Design goals

### Must keep (product / logic)
- Dialog shell classes / max-w-5xl / 90vh scroll / backdrop dismiss
- Summary metrics fields from `HedgePathSummaryMetrics` (cover, legs, resid VaR, breakeven)
- External performance host + ExposureHedgePathChart wiring
- Settle WAM chart (absolute Enhancement) + click apply
- Full scenario ladder columns / semantics / book & >Tf badges
- fmtK / fmtM; no new metrics without desk sign-off

### Should improve
- Clear **chapters**: Summary → Performance/setup → Settle WAM → Path
- Hero outcome: **Enhancement @ book WAM** (+ vs book) readable without scrolling to table end
- WAM table: Enhancement · vs book scan-first (column order / weight), split cols secondary
- Quieter summary cards (one primary accent; others neutral slate shells — same move as All Currencies expand)
- Header: title + compact meta chips instead of one long sentence
- Sticky modal header (title + Close) while body scrolls — optional, same tokens
- Narrow (~720) and wide (~1024 content) frames

### Nice to have
- Collapse WAM table behind “Show ladder” with chart always visible
- Sticky first column (Settle WAM) on horizontal scroll
- Legend for chart markers (book / proposal / beyond Tf) using existing swatches

---

## Interaction model (preserve)

```
[Backdrop click → close]
┌─ Modal ─────────────────────────────────────────┐
│ {CCY} — hedge carry profile          [Close]    │
│ Structure · Skew · Book WAM · schedule            │
│ [Cover] [Legs] [Resid VaR] [Breakeven]            │
│ [Performance · tick-trades + gear host]           │
│ ┌ Settle WAM · Enhancement ───────────────────┐ │
│ │ chart (click → apply WAM)                     │ │
│ │ ladder table (click row → apply)              │ │
│ └───────────────────────────────────────────────┘ │
│ ExposureHedgePathChart (Resid VaR + Exposure)     │
└───────────────────────────────────────────────────┘
```

Row click on Hedging summary opens modal (`profileCcy`). Applying WAM updates prepared package + schedule ends (gear Schedule setup).

---

## Sample data for mocks

EUR · Strip · 2 legs · Skew Neutral · Book WAM **M9** · schedule **M6/M12**

| Card | Value |
|------|-------|
| Strip cover · Target | +16.30M · 100% of forecast E_end · 0.0% unhedged |
| Strip legs | 2 · from M0 |
| Resid VaR | $0K · 0.0% @ … |
| Breakeven | (as in live UI) |

Settle ladder: M0…M12 rows; book row M9 highlighted; Enhancement curve with amber rings on M6 & M12.

---

## Deliverables from Claude Design

1. **Wide modal** (~1024 content) — full stack, EUR strip, WAM chart visible  
2. **Same modal, scrolled or focused** — WAM ladder with reordered/weighted columns  
3. **Narrow** (~720) — header chips + stacked summary; no invented mobile nav  

Also: annotated callouts (what changed vs current); Tailwind-class-compatible notes only.

---

## Prompt for Claude Design

Copy below (attach a screenshot of the live modal + this LOCKED STYLE block):

```
REFINE (do not redesign from scratch) an existing dark treasury modal: “{CCY} — hedge carry profile” in Deel Cash Carry analytics.

CRITICAL: Match the current UI system exactly. Do not invent a new visual language, light theme, new fonts, purple gradients, soft glows, rounded-full marketing CTAs, or replace tables with card dashboards. This is hierarchy / crowding / scanability only — same Tailwind class family as production.

LOCKED STYLE (already in production — copy these patterns):
- Backdrop: fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm; panel max-h-[90vh] max-w-5xl rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl
- Title: text-sm font-semibold text-white; meta text-[11px] text-slate-400; Close = rounded border border-slate-600 px-2 py-1 text-xs text-slate-300
- Structure violet-200; Skew/schedule amber-200/90; Book WAM emerald-200
- Section cards: rounded-lg border border-slate-700 bg-slate-950/40 p-3; section title text-[11px] font-semibold text-emerald-200; helper text-[10px] text-slate-500
- Summary cards today: 4-up grid gap-2; emerald / blue / red / amber tinted shells (border-*-700/40 bg-*-950/30); label text-[9px] uppercase; value font-mono text-sm
- Tables: text-[10px] font-mono; head text-slate-500; row border-t border-slate-800/80; book row bg-emerald-500/[0.08]; money +12.3K / +16.30M always signed
- Semantic colours: Enhancement emerald-100; FWD emerald-300; Default/Old amber; FCY violet; USD sky; vs book sky-200; negatives rose; struct violet
- Chart: absolute Enhancement line; amber rings = proposed settles; selected book on true Y (not forced to 0)
- Radii: xl dialog / lg section / md controls / rounded metric cards

WHAT TO IMPROVE (layout & hierarchy only):
- Chapter the modal: Summary → Performance/setup → Settle WAM → Path (visual separation without new chrome language)
- Make Enhancement @ book WAM (+ vs book) readable near the top without scrolling past a 12-col table
- Reorder/weight WAM ladder so Enhancement · vs book scan first; keep all column semantics
- Quieten summary cards: one primary accent, others neutral slate shells (same restraint as Cash Carry expand panel)
- Replace run-on header meta with compact chips (same colour tokens)
- Work at ~720 and ~1024 content widths inside max-w-5xl; sticky title/Close optional
- Sample: EUR Strip · 2 · Skew Neutral · Book WAM M9 · M6/M12; Cover +16.30M 100%

Deliver: 2–3 high-fidelity mockups that look like the SAME product, with callouts. If it wouldn’t drop into the current Tailwind class set, it’s wrong.
```

---

## What to paste into Claude Design (checklist)

1. **Screenshot** of the live modal (full height if possible, or top + WAM table crop)  
2. The **Prompt for Claude Design** block above  
3. Optional one-liner:  
   `Refine hierarchy only. Keep every Tailwind pattern in LOCKED STYLE. Do not change metric math or invent new chrome.`

---

## Implementation notes (for after design)

| Item | Location |
|------|----------|
| Portal / dialog | `CashCarryAnalyticsView.tsx` · `profileOpen` + `createPortal` |
| Summary cards | same file · `pathSummaryMetrics` grid |
| Perf host | `pathPerfPanelHost` ← `ExposureHedgePathChart` external placement |
| WAM chart | `SettleWamDeltaVsBookChart` |
| WAM ladder | settle scenarios table in modal |
| Path / gear | `ExposureHedgePathChart` props in modal |
| Apply WAM | `applySettleWamScenario` / `applySettleWamToPrepared` |
| Do not change | `buildSettleWamScenarios` definitions without FX desk sign-off |

Related brief (page-level hierarchy already shipped): `docs/design/cash-carry-all-currencies-claude-design.md` + handoff zip under `docs/design/design_handoff_cash_carry_all_currencies/`.
