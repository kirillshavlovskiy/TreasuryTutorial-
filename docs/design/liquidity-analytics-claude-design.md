# Design brief — Liquidity analytics tab

**Refinement only** — same dark slate Analytics panel. No new theme, no screenshots required.

**Code:** `LiquidityAnalyticsView.tsx` (rendered by `VarAnalyticsPanel` when `perspective === 'liquidity'`) · `LiquidityFrontierModal` · lib: `liquidity-strategies.ts` · `liquidity-frontier.ts` · `liquidity-ladder.ts`

**Sibling briefs:** CFaR (`cfar-analysis-claude-design.md`) · Cash Carry (`cash-carry-all-currencies-claude-design.md`) · hedge-carry modal (`hedge-carry-profile-modal-claude-design.md`) · **frontier modal** (`liquidity-frontier-modal-claude-design.md`)

---

## Entry

Analytics perspective rail → **Liquidity** tab (after CFaR).

Tab headline stat = live-regime **Funding cost** (`−netCostUsdYrM` of the desk’s current sizing/booking programme). Caption: `Funding cost`.

H2 suffix from the rail: *Liquidity funding — swap strategy comparison*.

---

## What this tab measures

The other Analytics tabs measure a **risk** (VaR, carry, CFaR). This one **prices the funding programme** that covers the dip in the dated cash path.

The unfunded ladder (`buildLiquidityLadder` / `liquidityCycles`) says how deep the book dips and when. It does **not** say how the desk covers the dip. Cover is a real choice with a real price: run the overdraft, buy a leg per cycle, pre-book the same strip today, or commit one term swap.

All four programmes are charged on the **same interest ledger** as the Liquidity desk P&L, so the comparison is like-for-like.

### Hard book split (do not blur in the UI)

| Band | What it holds |
|------|----------------|
| **Liquidity path** | Operating cash only: open, payouts, payins, cycle net, drawdown, trough, close |
| **Carry / buffer** | H* / Target LP Cash — sizes the *requirement*, not the swap |
| **Swap** | Funding swap: Swap Near, standing S, far leg, LP+Swap |
| **FX hedge** | Forwards / options / residual — settlement cash may sit on the path; the funding swap must not |

Never draw `swapNear` / `standing_swap` / `far_leg` into liquidity-book cells. The frontier’s S is a **swap-book** notional, shown as exposure to hedge — not as a liquidity-book close.

---

## Ledger (do not invent a fifth carry)

| Line | Meaning | Sign / color |
|------|---------|--------------|
| **Cash Carry** | Desk Cash + FWD (Cash Carry tab Total / P&L Cash + Hedge Cash). **Same on every strategy.** This is Total carry without the funding-swap overlay. | emerald if +, rose if − |
| **Swap cash** | Σ cycle cash Δr on the standing book (desk Buffer Carry) | sky / slate |
| **CIP / Swap points** | Market-data far-leg CIP on that book (desk CIP). Live regime uses the desk CIP map (already Δ-scaled). | emerald |
| **Total carry** | Cash + FWD + Swap cash + CIP | emerald emphasis |
| **Final CFaR** | Displayed Net CFaR: FX-hedge section RSS’d with this strategy’s funding-swap bridge | amber / rose (risk) |
| **Weighted return** | `Carry × 100% − CFaR × tail(conf)` · tail = 10% @ 90 · 5% @ 95 · 1% @ 99 | emerald if +, rose if − |
| **Δ vs do nothing** | Total carry of this programme minus **Run the overdraft** | emerald / rose |
| **Funding cost** | `−(Cash + FWD + Swap Carry)` — tab rail only | rose when a cost |

CIP at mid ≈ offsets Swap cash → Swap Carry ~ 0. Do **not** add CIP into frontier Y as a third mix.

---

## Four regimes (fixed set — do not add)

| Id | Label | What the desk puts on |
|----|-------|------------------------|
| `unfunded` | **Run the overdraft** | No swap. Trough goes negative; account pays `r_OD`. Baseline / “do nothing”. |
| `nearCycle` | **Near cycle only** | Trade the M1 leg spot; go back to market each cycle. |
| `rollingProgramme` | **Rolling programme** | Same legs, all booked today: M1 spot + the rest as forward-starting swaps. |
| `termSwap` | **One term swap** | One leg today, sized so every cycle still clears H*. |

**Live** = the regime written on `forecastProfile.liquidity` (sizing × booking). The other three are previews on the same dated path.

Notional of Near-cycle and Rolling is identical in this model (`sizingBasis` does not change `projectLiquidityCycles`). They still differ: one re-prices every cycle, the other locks the strip today. UI must not present them as a 2×2 duplicate.

---

## Buffer constraint (sizes H*, not the chart axes)

Layer stack is the **same** as the Liquidity tab. Changes apply immediately.

| Chip | Layers | Binding dial on the frontier |
|------|--------|------------------------------|
| Min floor | `floorH` | Min floor (left-end zoom) |
| Forecast accuracy | `sigmaP` + `cfarCover` | Min floor / σ buffer — payout-σ sizes Swap Near. CFaR is FX P&L, not extra FCY |
| Buffer Carry target | `carryOptim` | Target Carry (horizontal cut) |
| Portfolio VAR | `portfolioDiv` | Target VAR (vertical cut) — VaR wins over carry |

`resolveBufferConstraint`: Portfolio VaR (`portfolioDiv`) is Target VAR; carry is Target Carry; else balance (floor / payout-σ). FX Net CFaR is not a funding-swap size.

Constraint label on the regime row: **VaR** · **Carry** · **Balance**, plus a detail string (`Buffer Carry target · Min floor`).

---

## Tab chapter order (target)

Current code is a stack of prose strips + two tables + a modal. Redesign as five chapters, Cash Carry / CFaR rhythm.

| # | Block | Component | Job |
|---|--------|-----------|-----|
| 1 | **Summary** | 4 metric cards | Scan the *selected* (or live) programme |
| 2 | **Controls** | One toolbar | Confidence + buffer chips — not two prose sections |
| 3 | **Regimes** | Comparison table | Pick a programme |
| 4 | **Book** | Per-CCY table | Selected programme, currency by currency |
| 5 | **Frontier** | Modal | Click CCY → pick a return/risk sweet spot — see `liquidity-frontier-modal-claude-design.md` |

Chapter labels: `1 · Summary` · `2 · Controls` · `3 · Regimes` · `4 · Book` · (modal is not a page chapter).

---

## 1 · Summary cards

4-up grid. Semantic kit from the hedge-carry modal / CFaR cards.

| Card | Color | Value | Sub |
|------|-------|-------|-----|
| Total carry | **emerald** (rose if −) | `fmtK(book.total)` | Cash + FWD + Swap cash + CIP · selected regime |
| Final CFaR · {conf}% | **amber / rose** (risk) | `fmtK(finalCfarUsdM)` | FX + funding-swap bridge |
| Weighted return | **sky** (rose if −) | `fmtK(carry − CFaR × tail)` | `Carry × 100% − CFaR × {tail}%` |
| Live regime | **violet** if preview, **emerald** if live | `{label}` | `{VaR\|Carry\|Balance}` · `{constraintDetail}` |

When the selected row is not live, the fourth card reads **Preview** (violet) and the sub names the live regime so the desk does not confuse a what-if with the book.

Optional fifth chip (not a card): USD NP rate `r_USD` as a mono meta chip — do not spend a card on it.

---

## 2 · Controls

One section. Two control groups on one row (wrap on narrow).

**Confidence** — same chips as CFaR / VaR (`90 / 95 / 99`). Active `bg-blue-500/20 text-blue-100`. Writes `setup.confidencePct` (shared). Helper: `Carry × 100% − CFaR × {tail}% · z={z}`.

**Buffer regime** — four chips (Min floor · Forecast accuracy · Buffer Carry target · Portfolio VAR). Active tints:

| Chip | On |
|------|-----|
| Min floor | amber |
| Forecast accuracy | sky |
| Buffer Carry target | emerald |
| Portfolio VAR | violet |

Off: `border-slate-700 bg-slate-900/60 text-slate-500`. Dot `h-1.5 w-1.5` current / slate-700.

No long explanatory paragraphs in this chapter. One meta line: *Same layer stack as the Liquidity tab*.

---

## 3 · Regimes table

`overflow-x-auto` · `min-w-[820px]` · `text-[10px] font-mono`.

**Columns:** Regime · Constraint · Cash Carry · Swap cash · CIP · Total carry · Final CFaR · Weighted return

- Regime cell stacked: **label** + one-line `summary`. Badges: `Live` (emerald) · `Selected` (sky).
- Constraint cell stacked: **VaR / Carry / Balance** + detail.
- Money columns semantic-tinted (Cash / Total emerald · Swap sky · CIP emerald · CFaR amber · Weighted sky).
- Rows `role="button"` · Enter/Space · hover `hover:bg-slate-800/50` · selected `bg-sky-500/15 ring-1 ring-inset ring-sky-400/40` · live-but-not-selected `bg-sky-500/[0.06]`.
- Click selects the programme for chapter 4 and for the frontier modal. It does **not** persist the desk regime (no write-back to `forecastProfile` from this table).

Do not add Book now / Peak / Trips / Gap here — those belong on the per-CCY book or the nest.

---

## 4 · Book (per-CCY)

Same chrome as Cash Carry · Hedging summary. Header: `{Regime label} · live desk | preview`.

Helper one-liner: *Click CCY for frontier · Carry × 100% − CFaR × {tail}% → {weighted}*.

**Columns (always):** CCY · Struct · Settle skew · Schedule · Hedge Δ · FWD pts · Total carry · Δ vs do nothing · Weighted return

Same chrome as Cash Carry · Hedging summary (`rounded-lg border … p-3`, `text-xs`).

Settle skew is `—` (funding legs are not strip-skewed). Schedule is a **span** (`M1–M12`), never `M1/M2/…/M12`. Value dates live in the ▸ nest.

**Struct badges** (violet, like Cash Carry Strip/Bullet):

| Regime | Badge |
|--------|--------|
| unfunded | `—` |
| nearCycle | `near · N` |
| rollingProgramme | `strip · N` |
| termSwap | `bullet` or `term · N` |

Hedge Δ = near-leg `bookNow` in M FCY (sky). FWD pts = CIP $K (emerald). Value dates live in the leg nest, not as a Schedule column.

CCY cell: ticker + ▸▾ if a leg schedule exists. **Row click opens the frontier.** Chevron click expands the nest only (`stopPropagation`).

Hover `hover:bg-violet-500/10`. CCY `text-violet-200`.

`tfoot` **TOTAL $USD** when ≥1 CCY: Book now $M · CIP · Total · Δ vs do nothing · Weighted.

### Leg schedule nest

Same pattern as Cash Carry expand: `border-emerald-500/30` is *hedge*; this nest is **funding** — use `border-sky-500/30 bg-slate-950/70`.

Columns: Value date · Trade (`spot-start swap` amber / `fwd-start swap` sky) · New leg · Rolled in · Outstanding · FCY O/N · USD O/N · Points · Leg carry.

Footer: Book total = Swap cash + CIP (same as the parent row). Caption: *Each line is that cycle’s standing book — not the unfunded liquidity path.*

---

## 5 · Frontier modal

Separate brief — **chart + controls only, no point table:**

**`docs/design/liquidity-frontier-modal-claude-design.md`**

Entry: Book row click. Job: pick a **return / risk sweet spot** (Carry Y vs CFaR X) for that CCY. Open / Far toggle, stepper, leverage slider. Constraint cuts from the parent layer stack.

---

## Locked style

Reuse **`docs/design/design-system-claude.md`**.

- Panel: `rounded-xl border border-slate-700 bg-slate-900` (shell already on `VarAnalyticsPanel`)
- Section: `rounded-lg border border-slate-700 bg-slate-950/40 p-3`
- Cards: 4-up · `text-[9px]` labels · `font-mono text-sm` values
- Tables: `text-[10px] font-mono` · head `text-slate-500` · `min-w-[640px]` / `[720px]`
- Semantic: Carry emerald · CFaR / risk amber-rose · Cover / swap sky · Schedule amber · CCY / Decision violet · Live emerald · Selected sky · Open arm emerald · Far arm rose · Target Carry amber · Target VAR sky
- Liquidity / funding gap (if shown): fuchsia / amber — `text-fuchsia-300/80`
- Modal: `max-w-5xl` · `z-[200]` · `bg-black/60 backdrop-blur-sm`

---

## Sample data (mockups)

Tf = **6m**. USD NP **4.50%**. Confidence **95%** (tail 5%). Live = Rolling programme. Layers: Min floor + Buffer Carry.

### Summary (rolling, selected = live)

| Total carry | Final CFaR | Weighted return | Live regime |
|-------------|------------|-----------------|-------------|
| +$42.0K | $359K | +$24.1K | Rolling programme · Carry · Buffer Carry target · Min floor |

### Regimes

| Regime | Constraint | Cash | Swap | CIP | Total | CFaR | Weighted |
|--------|------------|------|------|-----|-------|------|----------|
| Run the overdraft | Carry | +$18K | $0K | $0K | +$18K | $361K | −$0.1K |
| Near cycle only | Carry | +$18K | +$22K | −$19K | +$21K | $380K | +$2.0K |
| **Rolling programme** Live | Carry | +$18K | +$22K | −$19K | +$21K | $380K | +$2.0K |
| One term swap | Carry | +$18K | +$31K | −$28K | +$21K | $410K | +$0.5K |

Cash Carry is **identical** across funded rows (desk cash, not the swap). Near vs Rolling totals match; CFaR / trips / rollover story differ.

### Book (EUR row)

| CCY | Struct | Hedge Δ | FWD pts | Total | Δ vs OD | Weighted |
|-----|--------|---------|---------|-------|---------|----------|
| EUR | strip · 6 | −12.40M | −$8.2K | +$14.1K | −$3.2K | +$6.0K |
| GBP | strip · 6 | +8.10M | −$4.1K | +$7.9K | +$2.1K | +$4.4K |

EUR frontier: origin CFaR **$359K** · carry **$0**. Green arm up and right; red arm down and right. Amber horizontal at Target Carry; two gold rings at the same X (open + / far −). Dashed tail after book S.

---

## Problems to fix / watch

1. **Two prose sections + chips** before any number — fold into chapter 1 cards + chapter 2 toolbar.
2. **No summary cards** — desk has to read the regime table to learn the live total.
3. **Leverage control looked dead** — must be a range that adds $10K steps and a visible dashed tail past book cash.
4. **S open / S far unclear** — same notional, two hedge states; say so on cards and the chart (no table).
5. **Constraint cuts** — Carry = horizontal; VAR = vertical; both must move when the layer stack changes.
6. **Row click vs chevron** — click CCY → frontier; chevron → legs only. Do not open the modal on chevron.
7. **Live vs selected** — preview must not look like the booked programme (violet Preview vs emerald Live).
8. **Cash Carry identical across strategies** — if the table implies it changes with the swap, the desk will not trust the ledger.
9. **Near vs Rolling** look like duplicates on carry — keep the summary/tradeoff visible so the difference (rollover vs lock-today) is readable.
10. **Do not mix books** — frontier S is swap exposure, not a liquidity-book close; no funded opening in any path sparkline you add later.
11. **Settle skew column is a dash** — hide it rather than teaching a false FX-hedge concept on the funding book.
12. **All-CCY CFaR** on the regime row is an RSS/sum of the displayed bridge — caption it as the strategy total, not a diversified portfolio VaR (that lives on Portfolio VAR).

---

## Associated functionality (design must support — do not invent)

Already implemented; layout around it, do not replace the math.

| Function | Where | UI consequence |
|----------|-------|----------------|
| `evaluateLiquidityStrategies` | 4 regimes × N CCY | Regime table + book table |
| `strategyForRegime` | live badge | Emerald Live on one row only |
| `strategyBookCarryK` | integer $K, same as Liquidity P&L | Totals must match the desk |
| `probabilityWeightedReturnUsdM` | confidence chips | Weighted column + card + helper formula |
| `resolveBufferConstraint` | layer chips | Dial + frontier cuts |
| `buildLiquidityLeftEndFrontier` | modal | 2D Carry vs CFaR, open + far only |
| `carryStepsToMaxK` | slider | $10K grid; more max → more points |
| `signedPeakStanding` / `bookCashCarryK` | solid vs dashed | Book join marker |
| `LiquidityFrontierConstraint` | H/V lines + hits | Amber horizontal · sky vertical |
| Shared `activeLayers` / `onLayerToggle` | Liquidity tab | Chips are not a local mock |
| Shared `setup.confidencePct` | CFaR / VaR | Same 90/95/99 chips |
| Desk maps `deskCashCarry` · `deskCip` | live regime CIP / cash | Live row cannot drift from Liquidity P&L |

**Out of scope for this design (do not add chrome for):**

- Persisting a regime from the comparison table back onto the forecast profile
- Editing H* / carry target / policy VAR numbers inside Analytics (those stay on Liquidity / Buffer)
- A 3-objective Pareto, a 1D buffer sweep, or CFaR-tab cover-ratio frontier (`cfar-frontier.ts` is a different object)
- Drawing the unfunded daily path as the main chart (that is the Liquidity tab’s book)
- Portfolio policy VAR $M as the frontier X (wrong scale — X is this CCY’s CFaR)

**Allowed later, reserve space only:** a sparkline of the *unfunded* trough beside CCY (open / trough / close from `liquidityCycles`, never funded `opening_cash`).

---

## Deliverables

1. **Chapter wire** — tab top→bottom (summary · controls · regimes · book)
2. **Summary card layout** — 4-up + live/preview state
3. **Regime + book tables** — columns, badges, selection, nest
4. **Frontier** — defer to `liquidity-frontier-modal-claude-design.md` (chart + controls, no table)
5. **What changed** vs the current stacked prose (bullet list)

No pixel-perfect mock required. Tailwind-class notes per block.

---

## Prompt for Claude Design (paste)

```
Refine the “Liquidity” Analytics tab in a dark FX treasury desk.

RULES: Same slate/emerald/violet/amber/rose/sky kit · dense 9–11px type ·
refinement only · no screenshots · no new theme

WHAT IT MEASURES: prices the funding programme that covers the dated-path dip
(not a third risk metric). Four regimes on one ledger: Run the overdraft,
Near cycle only, Rolling programme, One term swap. Live = desk sizing/booking.
Cash Carry is identical across strategies (desk Cash + FWD); the swap lives in Swap cash + CIP.
Weighted return = Carry × 100% − CFaR × tail(90/95/99).

HARD SPLIT: liquidity path (open/trough/close) never includes the funding swap.
Frontier S is swap-book notional (exposure to hedge), not a liquidity close.

CHAPTERS (top → bottom)
1. Summary cards: Total carry (emerald), Final CFaR (amber/rose), Weighted
   return (sky), Live regime (emerald) or Preview (violet)
2. Controls toolbar: Confidence 90/95/99 (blue) + buffer chips
   (Min floor amber · Forecast accuracy sky · Buffer Carry emerald ·
   Portfolio VAR violet)
3. Regimes table: Regime (Live/Selected badges) · Constraint · Cash · Swap
   cash · CIP · Total · Final CFaR · Weighted. Click selects. No persist.
4. Book table (selected regime): CCY · Struct (near/strip/bullet)
   · Hedge Δ · FWD pts · Total · Δ vs do nothing · Weighted.
   Row click → frontier modal (separate brief). Chevron → funding-leg nest only.

FRONTIER MODAL: see liquidity-frontier-modal-claude-design.md — chart +
controls to pick a return/risk sweet spot. No point table.

FIX: kill the two prose strips; add summary cards; Live vs Preview; hide the
dummy Settle-skew column; Cash Carry must look the same on every funded regime.

OUTPUT: Chapter wire · card layout · table columns/badges · Tailwind-class notes
(frontier modal is a separate prompt)
```

---

## Implementation map

| Data / state | Source |
|--------------|--------|
| Regimes | `evaluateLiquidityStrategies` · `LIQUIDITY_STRATEGIES` |
| Live id | `strategyForRegime(timing.sizingBasis, timing.bookingMode)` |
| Selected id | `selectedId` (local) |
| Carry $K | `strategyBookCarryK` / per-row cash+FWD+swap+CIP |
| Weighted | `probabilityWeightedReturnUsdM` · `cfarTailProbability` |
| Constraint | `resolveBufferConstraint` · `bufferConstraintDetail` |
| Layers | `activeLayers` · `toggleLayerGroup` · `FORECAST_ACCURACY_LAYERS` |
| Confidence | `setup.confidencePct` · `onSetupChange` |
| Book standing | `signedPeakStanding(plan)` |
| Frontier | `buildLiquidityLeftEndFrontier` · `carryStepsToMaxK` |
| Modal | `inspectCcy` → `LiquidityFrontierModal` |
| Empty | no FCY rows, or `forecastMonths < 1` |
