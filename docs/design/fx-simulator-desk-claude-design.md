# Design brief — FX Simulator desk (main component)

**Refinement only** — same dark desk shell. No new theme, no light-mode redesign, no marketing layout. No screenshots required.

**Code:** `app/dashboard/Simulator.tsx` (shell: tab nav + `<main class="mx-auto max-w-screen-2xl px-6 py-6">`) · `components/UnifiedSimulator.tsx` (globals toolbar + layers row + book table) · `GParam()` · `lib/fx-buffer.ts` (`LayerId`) · `lib/dashboard-model.ts` (computed rows)

**Kit:** `docs/design/design-system-claude.md` — but read **Locked style** below first: this component is the one surface written in *light* Tailwind utilities and re-tinted by a CSS remap.

---

## Product intent

One live FCY book. The desk edits a spreadsheet-grade table (positions, cash, rates, forecast) and reads the model's answer in the same row: buffer target H\*, swap near leg, residual FX, carry P&L. Everything above the table is the **model input frame** — book-wide parameters plus which buffer layers are in the target formula.

Same component serves two tabs on the same live book:

| Tab | Column groups | Toolbar |
|-----|---------------|---------|
| **FX Simulator** | + FX HEDGE · full P&L (5) | + Hedging strategy chips |
| **Liquidity** | no FX HEDGE · P&L carry-only (2) | layers only (incl. Portfolio VAR) |

---

## Zone map (top → bottom, as shipped)

| # | Zone | Current markup | Job |
|---|------|----------------|-----|
| 1 | **Tab nav** | `nav border-b bg-white` · 10 underline tabs, blue active | Switch desk surface |
| 2 | **Global parameters** | `rounded-lg border-gray-200 bg-gray-50 px-4 py-3` · one `flex-wrap items-end gap-x-6` row | Book-wide model inputs |
| 2a | r_USD | `GParam` — number + `% p.a.` | USD deposit rate |
| 2b | Incremental forecast uncertainty | `GParam` — number + `%` (σ_P ×100) | Payout σ layer input |
| 2c | Exposure period | 6 pills — `0 month · 1 · 3 · 6 · 9 months · 1 year` | Forecast buildup F×T (**not** the VaR horizon) |
| 2d | Actions (`ml-auto`) | `Forecast profile…` (+ violet `custom` badge, disabled at 0m) · `Reset table` | Open BS cash modal · restore seed book |
| 3 | **Layers row** | `Layers:` + 4 chips + gear · then `Hedging strategy:` + 3 chips | Which layers enter H\* |
| 3a | Min floor + **gear** | chip + gear w/ count badge → inline per-CCY floor panel | Hard cash minimum per CCY (M FCY) |
| 4 | **Portfolio VAR strip** | violet band — `$5M/$10M/$20M` presets · slider · number · overlay sensitivity / overlay carry / binding flags | Sensitivity budget when that layer is on |
| 5 | **Book table** | `overflow-x-auto overflow-y-auto max-h-[calc(100vh-10rem)] rounded-lg border` | The workspace |

---

## Locked style (read carefully — this surface is different)

The desk is authored in **light** utilities and remapped to dark by `app/globals.css` under a `.sim-dark` ancestor (`Simulator` sets it when `embedded`). Descendant selectors out-specify the single-class utilities, so the same JSX renders light standalone and dark embedded.

**Consequence:** every token you propose must exist in that remap, or it renders light-on-dark.

| Safe to use | Remapped to (dark) |
|-------------|--------------------|
| `bg-white` · `bg-gray-50` · `bg-gray-100`–`900` | `#0f172a` · `#0b1220` · `#1e293b` … |
| `border-gray-100`–`400` | `#1e293b` → `#64748b` |
| `text-gray-400`–`900` | inverted `#94a3b8` → `#f8fafc` |
| semantic `-50` / `-100` backgrounds | 12% / 20% tint of the hue |
| any `text-{hue}-*` · `border-{hue}-*` | lightened / 40% alpha border |
| `hover:bg-gray-50/100/200` | slate hovers |

- **Do not** propose `slate-*` classes here, or arbitrary hexes, or a light/dark class fork — that is the Analytics panels' idiom, not this one.
- Semantic hues already in use per group: RATES gray · FX POSITION white · **LIQUIDITY sky** · **IR rose** · **CARRY/BUFFER amber** · **SWAP emerald** · **FX HEDGE rose (2px rule)** · **RISK METRICS violet** · **P&L purple**. Keep the mapping; refine weight and rhythm only.
- Table density stays: `text-[11px]` cells, `tabular-nums`, borderless inputs that reveal a focus ring (`inBase`).

---

## Targets

### Toolbar (zone 2)

Three unrelated jobs share one gray card today. Target: same card, three labeled clusters plus a right-side action group that wraps predictably.

```
┌ Model inputs ─────────────────┬ Forecast ─────────────┬───────── actions ┐
│ r_USD [3.50] % p.a.           │ Exposure period       │ Forecast profile…│
│ Fcast uncertainty [15] %      │ [0m][1m][3m][6m][9m][1y] │ Reset table   │
└───────────────────────────────┴───────────────────────┴──────────────────┘
```

- Cluster captions at `text-[9px] uppercase tracking-wide text-gray-500`; keep `GParam` anatomy.
- Exposure period needs an inline "buildup F×T · not the VaR horizon" hint — that fact currently lives only in a `title`.
- `Forecast profile…` disabled at `0 month` must read as *conditional*, not broken (hint next to it, not only a tooltip).
- Keep `custom` badge (violet) on the button when the profile is per-period.

### Layers row (zone 3)

- `Min floor · Payout σ buffer · Carry target · Portfolio VAR` — all four on both tabs.
- Each chip should hint **which column group it moves**: layers drive CARRY/BUFFER → SWAP. A one-line legend under the row is acceptable.
- Gear belongs to Min floor only; count badge = currencies with a floor set. Decide: inline expand (current) vs anchored popover.
- Hedging strategy chips (FX Simulator tab) must read as a *different* family from buffer layers — today both are same-size pills, only hue differs (blue vs rose).
- Per-CCY floor panel content: CCY · input (M FCY) · `$USD` equivalent · `Σ $USD` header total · Done. Needs a designed column rhythm at 3-up.

### Book table (zone 5)

~45 columns in 9 group headers. Two things to solve:

1. **Group orientation while scrolling horizontally** — group header row is sticky-ish but the desk loses which band it's in. Want persistent band cues (rule weight, tint edges, or a group rail).
2. **TOTAL row semantics** — M FCY columns are *not* additive and render `—`; only `$USD` columns sum, and three of them are zero-sum checks (`Σ Swap $USD = 0`, `Σ Net FX $USD = 0`). Zero-sum cells deserve a distinct treatment from "no total".

| Group | Cols | Notes |
|-------|------|-------|
| CCY | 1 | first column, editable code |
| RATES | 3 | full book only |
| FX POSITION | 12 (16 simplified) | editable, two-way FCY ↔ $USD pairs |
| LIQUIDITY BOOK | 9 | LP cash · payouts · payins · Non-LP · trough · cycle net · total |
| IR / FIXED-RATE BOOK | 2–6 | per selected inputs |
| CARRY / BUFFER | 3 | H\* target — layer output |
| SWAP | 6 | near leg sized from H\* |
| FX HEDGE | 5 | FX Simulator tab only · amber "swap only" badge |
| RISK METRICS | 4 | Exp · Booked H · Residual · VaR |
| P&L | 5 / 2 | carry-only on Liquidity |

---

## Sample data (mockups)

Book: **EUR · PLN · CAD · USD**. r_USD `3.50`, uncertainty `15%`, Exposure period `3 months`.

| CCY | LP Cash | Gross payouts | Trough | Min floor | H\* target | Swap near | Cash carry |
|-----|---------|---------------|--------|-----------|-----------|-----------|------------|
| EUR | 42.10 | −18.40 | 23.70 | 5.00 | 31.85 | +8.15 | +$41K |
| PLN | 86.50 | −12.00 | 74.50 | 10.00 | 79.20 | +4.70 | +$120K |
| CAD | 7.80 | −200.00 | −192.20 | 2.00 | 15.55 | +207.75 | −$18K |
| USD | 303.90 | −40.00 | 263.90 | — | 268.40 | −(Σ FCY) | +$88K |
| TOTAL | — | — | — | Σ `$17.4M` | — | `0.00` ✓ | +$231K |

Layers on: Min floor · Payout σ buffer · Carry target. Portfolio VAR off (strip hidden). Floors set on 3 of 3 FCY → gear badge `3`.

---

## Problems to fix

1. **Chrome eats the fold** — ~200px of toolbar + layers before the first data row; the table is the product
2. **Toolbar is one undifferentiated gray card** — rates, forecast period, and destructive-ish actions share a row with no captions; `ml-auto` cluster collides on narrow widths
3. **Exposure period reads like a VaR horizon** — the disclaimer is tooltip-only
4. **Layers vs hedging strategy look like one control family** — same pill shape, different hue only
5. **No link from layer chips to the columns they move** — desk toggles blind
6. **Min-floor gear panel has no designed home** — inline expand pushes the table down; popover would cover it
7. **45 columns, 9 bands, weak orientation** — no persistent cue for which group you're scrolled into
8. **TOTAL row conflates three meanings** — real sum · not-additive `—` · zero-sum invariant check
9. **10 tabs in one flat row** — no grouping between book / decision / analytics surfaces
10. **Disabled states read as bugs** — `Forecast profile…` at 0 months, `Portfolio VAR` strip appearing/vanishing with a toggle

---

## Deliverables

1. **Zone wire** — tab nav · toolbar clusters · layers row · conditional strips · table (ASCII fine)
2. **Toolbar layout** — cluster captions, wrap behavior at ~900px, action group placement
3. **Layers row kit** — buffer-layer chip vs strategy chip vs gear, plus the layer → column-group legend
4. **Floor panel** — inline vs popover recommendation with the 3-up CCY row rhythm
5. **Table band system** — group orientation cue + TOTAL row treatment (sum / `—` / zero-sum ✓)
6. **What changed** — bullets vs current, in remap-safe classes only

---

## Prompt for Claude Design (paste)

```
Refine the main FX Simulator desk in a dark treasury workbench (Next.js + Tailwind).

SURFACE: one live FCY book. Above a ~45-column spreadsheet sit the model inputs:
book-wide parameters, then chips choosing which buffer layers enter the cash
target H*. Same component serves an FX Simulator tab (with FX HEDGE columns +
hedging-strategy chips) and a Liquidity tab (no hedge columns, carry-only P&L).

HARD CONSTRAINT — this surface is authored in LIGHT Tailwind utilities and
remapped to dark by CSS under a .sim-dark ancestor. Only propose tokens that the
remap covers: bg-white / bg-gray-50..900, border-gray-100..400, text-gray-400..900,
and semantic -50/-100 tints (sky, rose, amber, emerald, violet, purple).
Do NOT propose slate-* classes, raw hexes, or a light/dark class fork.

ZONES (top → bottom)
1. Tab nav — 10 underline tabs (book / decision / analytics surfaces, ungrouped today)
2. Global parameters card: USD deposit rate r_USD (% p.a.) · Incremental forecast
   uncertainty (%) · Exposure period pills 0m/1m/3m/6m/9m/1y · right actions
   "Forecast profile…" (disabled at 0m, violet "custom" badge) + "Reset table"
3. Layers row: Min floor [gear + count badge] · Payout σ buffer · Carry target ·
   Portfolio VAR; then (FX tab only) Hedging strategy: Swap only / +Fwd / +Option
4. Conditional strips: per-CCY min-floor panel (gear) · violet Portfolio VAR
   sensitivity-limit band (presets + slider + overlay readouts)
5. Book table — 9 column bands: RATES gray · FX POSITION white · LIQUIDITY sky ·
   IR rose · CARRY/BUFFER amber · SWAP emerald · FX HEDGE rose · RISK METRICS
   violet · P&L purple. TOTAL row mixes real sums, non-additive "—" (M FCY),
   and zero-sum invariant checks (Σ Swap $USD = 0, Σ Net FX $USD = 0).

FIX
- Chrome eats the fold (~200px before row 1) — the table is the product
- Toolbar is one flat gray card: add cluster captions, fix wrap at ~900px
- "Exposure period" reads as a VaR horizon; it is forecast buildup F×T only
- Buffer-layer chips and hedging-strategy chips look like one family
- Layer chips give no hint which column band they move (layers → CARRY/BUFFER → SWAP)
- Min-floor gear panel needs a home: inline expand vs anchored popover
- 45 columns / 9 bands: need persistent orientation while scrolling sideways
- TOTAL row must distinguish sum vs not-additive vs zero-sum ✓
- Disabled/conditional controls must not read as broken

OUTPUT
1) Zone wire (nav · toolbar · layers · strips · table)
2) Toolbar cluster layout + wrap behavior
3) Chip kit: buffer layer vs strategy vs gear + layer→band legend
4) Floor panel recommendation (inline vs popover) with 3-up CCY rhythm
5) Table band orientation cue + TOTAL row treatment
Refinement only — no new brand, no light mode, remap-safe classes.
```
