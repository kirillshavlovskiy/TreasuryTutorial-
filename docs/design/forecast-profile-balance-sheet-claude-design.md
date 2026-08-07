# Design brief — Forecast profile · Balance-sheet cash structure

**Refinement only** — same dark slate `sim-dark` modal. No new theme, no light-mode redesign, no marketing layout.

**Code:** `components/UnifiedSimulator.tsx` (portal `forecastProfileOpen`) · `forecastProfileUi()` · `lib/forecast-profile.ts` (`FORECAST_FLOW_LINES`, flat / custom modes)

**Tf source of truth:** FX Risk input model (`setup.forecastMonths`) — do **not** reintroduce a period pill row inside this modal.

No screenshots required.

---

## Product intent

Desk inputs the **financial balance-sheet cash structure** that drives the FX exposure path:

| BS / CF family | Modal lines (`FORECAST_FLOW_LINES`) | Sign |
|----------------|--------------------------------------|------|
| Operating | Revenue · Expenses | in / out |
| Working capital | NWC in · NWC out | in / out |
| Financing | Debt draw · Debt repay | in / out |
| Investing | Invest in · Invest out | in / out |
| Other | Other in · Other out | in / out |
| AR / invoice | Invoice fcast | in |
| Derived | **Net** (read-only) | — |

Two edit modes:

1. **Flat formula** — monthly amount × Tf · per-line Growth % MoM · Period Σ  
2. **Custom by period** — M1…MTf grid · Excel-like formulas · fill-handle across months  

Uncertainty: click a **line name** → 1m projection σ (feeds Analytics quantity risk).

---

## Entry

| Surface | Affordance |
|---------|------------|
| Simulator toolbar | “Forecast profile…” |
| Analytics / Cash Carry | Gear next to “Cash carry · all currencies” (`onOpenForecastProfile`) |
| FX Risk | Same shared modal when wired |

Shell: `fixed inset-0 z-[200]` · backdrop close · panel `max-w-5xl` · `max-h` scroll inside table wrap (~60vh today).

---

## Modal chapter order (target)

| # | Block | Purpose |
|---|--------|---------|
| 1 | **Header** | Title · Tf chip (read-only from FX Risk) · mode · Close |
| 2 | **Structure chrome** | BS family tabs or grouped legend · Default growth · Flat/Custom actions |
| 3 | **Editor grid** | Flat table **or** Custom M1…MTf table (one mode at a time) |
| 4 | **Footer** | Period net summary per CCY · Done / Close · formula cheat-sheet (collapsed) |

---

## Components to refine

| Component | Current | Target |
|-----------|---------|--------|
| **Title** | “Forecast profile — Cash inflows / outflows” | “Forecast profile — Balance-sheet cash” (or keep Cash in/out as subtitle) |
| **Helper copy** | Long paragraph (formulas + drag + seed) | One short line + optional “Formula help” disclosure |
| **Mode switch** | Flat formula · Custom by period | Keep · stronger segment track (slate / sky on) |
| **Tf** | Buried in helper text | Chip: `Tf {N}m · from FX Risk` (not editable here) |
| **Default growth** | Inline % MoM | Keep compact; label “Default g MoM” |
| **Actions (custom)** | Fill from flat · Copy M1 → all | Keep; secondary slate buttons |
| **Line labels** | Flat list + tiny in/out | Group by BS family with subtle section rows **or** left rail family filter |
| **Grid** | Dense bordered cells · sticky CCY + Line | Keep density; clearer In (emerald) / Out (rose) · formula violet override |
| **σ chip** | Amber on line after set | Keep; make click target obvious (underline / σ affordance) |
| **Footer** | Done button (find in file) | Sticky footer: Done · optional All-CCY period net |

---

## Locked style (dark / Analytics kit)

Match `forecastProfileUi(true)` + Analytics sections:

- Panel: `rounded-xl border border-slate-700 bg-slate-900 p-5`
- Table wrap: `rounded-lg border border-slate-600 bg-slate-950 max-h-[60vh] overflow-auto`
- Title: `text-sm font-semibold text-slate-100`
- Meta: `text-[11px] text-slate-400` · Tf chip `font-mono text-sky-200`
- Mode on: `bg-sky-600 text-white` · off: `text-slate-400`
- In rows: `bg-emerald-950/45` · Out rows: `bg-rose-950/45`
- Formula override: `bg-violet-950/70 ring-violet-500/55`
- Inputs: `font-mono text-[11px] text-sky-100`
- σ chip: `bg-amber-500/20 text-amber-200`
- Density: 11px table · sticky CCY + Line columns

Do **not** switch to purple-on-white, cream serif, or card-hero marketing layouts.

---

## Flat mode — columns

| Col | Content |
|-----|---------|
| CCY | Sticky · show once per currency block |
| Line | Sticky · label · side · σ chip · click → uncertainty |
| Monthly | Editable M FCY (outflows entered positive in UI) |
| Growth % MoM | Per-line growth cell — see **Growth cells** below |
| Period Σ ×Tf | Read-only path sum |

---

## Growth cells — how editing should look

Applies to **Flat formula** mode (per-line `Growth % MoM` column) and the chrome **Default g MoM** control. Custom mode has no per-month growth column; growth is expressed via formulas (`=prev*exp(0.05)`) or “Fill from flat”.

### Data model (do not invent new fields)

| Control | State key | Unit in UI | Stored |
|---------|-----------|------------|--------|
| Default growth (chrome) | `growthRateMoM` | percent, e.g. `1.5` | decimal `0.015` |
| Per-line growth (flat grid) | `flatGrowthByCcy[ccy][field]` | percent | decimal |
| Resolved line growth | `lineGrowthMoM(profile, ccy, field)` | — | line override if set, else Default |

Path math: month \(k\) amount ≈ Monthly × (1 + g)^k (existing `seedMonthsFromRowWithLineGrowth`).

### Cell anatomy (flat grid)

```
┌──────── Growth % MoM ────────┐
│  [  1.50  ]                  │  ← mono input, right-aligned, max ~72px
│           %                  │  optional trailing “%” muted (or header-only)
└──────────────────────────────┘
```

| State | Look | Value shown | Behavior |
|-------|------|-------------|----------|
| **Inherited** (no line override) | Muted text / softer border (`text-slate-500`, ring slate) | Resolved Default as placeholder-style, e.g. ghost `1.50` **or** empty with placeholder `default` | Clearing the cell / leaving blank on blur → remove line override, fall back to Default |
| **Override** (line has own g) | Same as Monthly editable: `text-sky-100`, sky focus ring | Explicit `%`, 1–2 decimals (`1.5`, `0`, `-0.5`) | Commit on blur → write `flatGrowthByCcy` |
| **Editing (focus)** | Sky focus ring (`focus:ring-sky-500/40`) · select-all friendly | Raw draft string while typing | `step 0.1` · allow negative MoM |
| **Net row** | Em dash muted | `—` | Not editable |
| **Zero override** | Explicit `0` (sky), not muted | `0` | Means “no growth for this line”, **not** inherit |
| **Invalid / empty mid-edit** | Keep draft; on blur if non-numeric → treat as `0` override **or** inherit (prefer **inherit** when blank) | — | Target: blank = inherit; `0` = hard zero |

**Today’s gap:** the grid always shows the *resolved* number and always writes an override on blur — inherited vs override is not visually distinct, and blank ≠ inherit. Design should make inheritance obvious.

### Default growth (chrome)

```
┌ Default g MoM ┐
│ [ 1.50 ] % MoM │  compact chip · border-slate-600 · bg-slate-950
└────────────────┘
```

- Label: `Default g MoM` (tooltip: “Used by lines without their own Growth cell”).
- Changing Default **immediately** changes Period Σ for inherited lines; overridden lines unchanged.
- Custom mode: same control = seed rate for “Fill from flat” / mode switch — not a grid column.

### Pairing with Monthly + Period Σ

| Monthly | Growth | Period Σ ×12 (example) |
|---------|--------|-------------------------|
| `3.50` | inherit `1.0%` | geometric path sum (not 3.50×12) |
| `3.50` | override `0` | `3.50 × Tf` flat |
| `3.50` | override `2.0%` | steeper path · Σ updates live on blur |

Growth cell sits **between** Monthly and Period Σ so the desk reads: amount → growth → path total.

### Custom mode (no growth column)

- Do **not** add a Growth column to the M1…MTf grid.
- Show growth via:
  - violet formula cells (`=prev*exp(0.05)`), and/or
  - chrome hint: “Fill from flat uses Default g MoM + per-line flat growth”.
- Optional later: tiny `g` badge on Line when flat override exists (out of scope unless easy).

### Visual tokens (growth-specific)

| Token | Class / note |
|-------|----------------|
| Input base | `fpu.input` · `max-w-[72px]` · `font-mono text-[11px] tabular-nums` |
| Inherited | muted value or placeholder · weaker ring |
| Override | `text-sky-100` · same weight as Monthly |
| Focus | sky ring (match Monthly / Default) |
| Header tooltip | “MoM growth for this line · blank inherits Default g MoM · 0 = no growth” |

---

## Custom mode — columns

| Col | Content |
|-----|---------|
| CCY · Line | Sticky (same as flat) |
| M1 … MTf | `FormulaCell` · `=prev*exp(0.05)` · `=m1` · `$m1` · drag-fill |
| Period net | Σ months for that line / Net row |

---

## Sample data (mockups)

Tf = **12m**. EUR + GBP books.

Default g MoM chrome = **1.0%**.

| Line | Side | EUR Monthly | Growth cell | Growth state | Note |
|------|------|-------------|-------------|--------------|------|
| Revenue | in | 3.50 | `1.0` muted/ghost | **inherited** | operating |
| Invoice fcast | in | 0.80 | `0` sky | **override zero** | AR flat |
| NWC in | in | 0.40 | (empty / `default`) | **inherited** | BS WC |
| Debt draw | in | 0 | — or `0` | idle | |
| Expenses | out | 2.10 | `0.5` sky | **override** | operating |
| NWC out | out | 0.25 | inherited ghost | **inherited** | BS WC |
| Debt repay | out | 0.10 | `0` sky | **override zero** | financing |
| Net | — | ~2.25 | `—` | n/a | derived |

Custom: M1 Revenue `3.50` · M2 `=prev*exp(0.01)` · formula cells violet · no Growth column.

---

## Problems to fix

1. **Wall of help text** — formulas + drag + seed buried in header; desk can’t scan structure
2. **No BS hierarchy** — 11 lines look like a flat CF dump, not balance-sheet structure
3. **Tf ambiguity** — period feels editable; must read as FX Risk–owned
4. **Mode chrome crowded** — growth + actions + hint compete on one wrap row
5. **Custom grid width** — many months → horizontal scroll without clear month-band cues
6. **σ discoverability** — “click line name” is easy to miss
7. **Growth inherit vs override** — cells always look “set”; blank ≠ inherit; `0` vs Default unclear
8. **Light + dark fpu** — Claude Design targets **dark / Analytics** path (`sim-dark`); keep light tokens as-is unless trivial

---

## Deliverables

1. **Chapter wire** — header · structure chrome · editor · footer (ASCII ok)
2. **BS grouping** — recommend section rows vs filter chips (Operating / NWC / Debt / Invest / Other)
3. **Header / chrome layout** — Tf chip · mode · Default g MoM · actions · formula help disclosure
4. **Growth cell states** — inherited / override / zero / focus / Net (sketch or token notes)
5. **What changed** — bullets vs current modal (no pixel mock required)

---

## Prompt for Claude Design (paste)

```
Refine “Forecast profile” modal in a dark FX treasury simulator (sim-dark slate).

PRODUCT: Desk edits balance-sheet cash structure that drives the FX forecast path —
Operating (Revenue/Expenses), NWC, Debt, Invest, Other, Invoice fcast, Net.
Modes: Flat formula (monthly × Tf + Growth % MoM) · Custom by period (M1…MTf + Excel formulas).
Tf is READ-ONLY from FX Risk input model — show as chip, do not add period pills.
Click line name → set 1m projection uncertainty σ.

GROWTH CELLS (flat mode — specify visual states):
- Chrome “Default g MoM” percent input (decimal stored).
- Per-line Growth % MoM between Monthly and Period Σ; mono ~72px; Net = —.
- Inherited (no override): muted/ghost showing default OR empty placeholder “default”; blank on blur = inherit.
- Override: sky mono like Monthly; explicit 0 = hard zero (not inherit).
- Focus: sky ring; commit on blur; negative MoM allowed.
- Custom mode: no Growth column — formulas / Fill from flat only.

RULES: Refinement only · same slate/emerald/rose/violet/sky/amber kit · dense 11px mono grid · sticky CCY+Line · no new visual brand

CHAPTERS (top → bottom)
1. Header: title “Forecast profile — Balance-sheet cash” · Tf chip · Close
2. Chrome: Flat/Custom mode · Default g MoM · Fill/Copy actions · collapsed Formula help
3. Editor: grouped BS lines (In emerald / Out rose) · Flat columns or Custom month grid
4. Footer: Done · optional period-net glance

FIX: Cut header wall-of-text · make BS structure scannable · Tf ownership clear · σ clickable · less crowded chrome · distinguish growth inherit vs override

OUTPUT: Chapter wire · BS grouping · header/chrome · Growth cell state kit · table column notes
```
