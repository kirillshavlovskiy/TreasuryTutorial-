# Design brief — Liquidity efficient-frontier modal

**Refinement only** — same dark slate modal. No new theme, no screenshots required.

**Parent tab:** `docs/design/liquidity-analytics-claude-design.md`  
**Code:** `LiquidityFrontierModal.tsx` · lib: `liquidity-frontier.ts` (`buildLiquidityLeftEndFrontier`) · weighted return: `probabilityWeightedReturnUsdM`

**No point table.** The chart plus controls are the picker. Selected state lives on the cards, the readout, and the highlighted dot — not in a grid under the plot.

---

## Entry

Liquidity Analytics · Book row click → `{CCY} — liquidity frontier`  
`max-w-5xl` · `max-h-[90vh]` · backdrop / Esc close · ← → steps along the selected arm

---

## What the desk is doing

Pick a **sweet spot** on the efficient frontier: **return vs risk** for one currency and one funding programme.

| Axis | Meaning |
|------|---------|
| **X · risk** | CFaR $K of standing S held to the far settle (RSS with the CFaR-section origin) |
| **Y · return** | Carry $K/yr — open = cash; far = cash + swap points |
| **Sky overlay** | Probability-weighted return `Carry × 100% − CFaR × tail(conf)` — the score used to rank a point |

Same notional **S** is two outcomes:

- **Open (green)** — unhedged / incomplete. Y = cash. FX revaluation risk.
- **Far (red)** — far leg on. Y = cash + points. Early-unwind vs K, not a second spot mark.

Origin = **(section CFaR, carry $0)**. Only that point sits on the CFaR tab’s section with Y = 0.

Solid = live book. Dashed = leveraged S past that book.

---

## Modal chapter order (target)

| # | Block | Job |
|---|--------|-----|
| 1 | Header + chips | CCY · regime · binding dial · book S |
| 2 | Sweet-spot cards | The picked combination — risk, return, S, E[return] |
| 3 | Chart | The frontier — click a dot to pick |
| 4 | Controls | Adjust the surface and walk the sweet spot |

**Drop:** the Band / Cover / S / Cash / Points / Carry / CFaR table. Do not replace it with another grid.

---

## 1 · Header

Title: `{CCY} — liquidity frontier`

Meta chips (must match the live engine):

| Chip | Example |
|------|---------|
| Regime | `Rolling programme` |
| Dial | `Target Carry` · `Target VAR` · `Min floor` |
| Book | `S −12.4 M · cash +$40K` |
| Layers | `Buffer Carry target · Min floor` |

Close (ghost) top-right. No long prose paragraph — one optional helper under the chips:

*Click a dot or use the stepper. Green = open cash · red = far hedge · dashed = leverage.*

---

## 2 · Sweet-spot cards (4-up)

The selected point. Updates on click / stepper / Open–Far toggle.

| Card | Color | Value | Sub |
|------|-------|-------|-----|
| Return · Carry Y | **emerald** (rose if −) | `fmtK(carry)` | Open = cash · far = cash + points |
| Risk · CFaR X | **amber / rose** | `fmtK(cfar)` | Same X on both arms |
| E[return] | **sky** (rose if −) | `fmtK(carry − CFaR × tail)` | `Carry × 100% − CFaR × {tail}%` |
| Exposure S | **emerald** open / **rose** far | `{n.n} M` | `Open` or `Far` · same notional |

When the point is the origin: S `—` · carry `$0K` · CFaR = section.

Constraint hits (if a cut is on) can sit as a one-line readout under the cards, not a fifth card:

- Amber: `Target Carry +$40K → open +$40K / far −$12K @ $412K`
- Sky: `VAR $412K → open +$40K / far −$12K`

---

## 3 · Efficient-frontier chart

Hero of the modal. Full width under the cards. Opaque section `bg-slate-950`.

### Locked geometry

| Mark | Meaning |
|------|---------|
| White origin | Section CFaR · carry $0 |
| Solid **green** polyline + dots | Open arm · live book |
| Dashed **green** | Leveraged open S |
| Solid **red** polyline + dots | Far-hedge arm · live book |
| Dashed **red** | Leveraged far |
| Sky polyline (optional, thin) | E[return] along the selected arm — only if it does not crowd Y; otherwise E[return] stays on the card |
| Amber **horizontal** | Target Carry — same S, two Y |
| Sky **vertical** | Target VAR — carry open vs far at that CFaR |
| Gold rings | Constraint hits · `open S {n} · {$K}` / `far S {n} · {$K}` |
| White ring | Book join (solid → dashed) · `book S {n}` |
| Faint connector | Vertical between the two rings (same S) |
| Sky filled dot (larger) | **Sweet spot** — the picked point |

X label: `CFaR ($K) — risk`. Y label: `Carry ($K/yr) — return`.  
X ticks must be distinct $K (never a row of identical `$359K`).

Click a dot to pick. Hover: faint ring + tooltip `{arm} · S {n} · carry {$K} · CFaR {$K} · E[return] {$K}`.

**Frame the live book and the $0-carry origin** (section CFaR labelled on the point and as an X tick). Do not scale the axes to the leveraged dashed tail — Leverage adds that tail and it clips. Min floor keeps the steep left readable. Carry / VAR still draws the cut if it sits on the live book. Sample **geometrically** from ~$0.25K (next to origin / section CFaR) so the green arm is not a few long chords.

**Do not:** a 3rd independent axis; linear fake CFaR; pin every point to section CFaR; non-zero carry on the origin; spray 25/50/75 covers onto every S as a third family of arms (Δ lives on the **selected S** only — RSS mix, not a straight chord); CIP in Y except as far-arm points; a data table under the plot.

---

## 4 · Controls (pick and adjust)

One toolbar under the chart. This is how the desk **adjusts the surface** and **walks the sweet spot**. No table.

### Arm (return state)

Segmented: **Open** (emerald on) · **Far** (rose on).  
Snaps Δ to the twin at the same S. Origin stays origin.

### Δ residual (iso-S mix)

Slider **1 (open) ↔ 0 (far)** on the **picked S** only.  
Y = cash + α × points (linear). X = RSS mix of leftover FX σ and far unwind — a **curve**, not the straight chord. Sample α with extra knots at Y = 0 (asinh) and the FX/unwind RSS corner; yellow dots at intermediate Δ on this slice only. Desk residual Δ = 1 − cover. Does not persist.

### Stepper (walk the frontier)

`‹` · `{i} / {n}` · `›`  
Steps along the **current arm** (risk ↑ as S grows). Keyboard ← → / ↑ ↓. Disabled at the ends.

Optional: a range slider bound to the same index (one thumb, `1…n`) so the desk can scrub risk without clicking dots.

### Leverage (extend the surface)

Range + $K box. Label: **Leverage · max cash-carry step**.  
Readout: `book {$XK} solid · max {$YK} dashed`.  
Dragging past book cash **must** lengthen the dashed tail. Does not move the live book or the constraint cuts.

### Binding cut (read-only here)

Not a third slider. The layer stack on the parent tab sets the dial:

| Dial | Chart response |
|------|----------------|
| Target Carry | Amber horizontal + gold rings |
| Target VAR | Sky vertical + gold rings |
| Min floor | Left zoom · no extra cut |

Do **not** add carry-target / VAR number fields in the modal (those stay on Liquidity / Buffer).

### Confidence (optional, if space)

Same 90 / 95 / 99 chips as the parent tab (blue). Only affects the **E[return]** card and any sky overlay — not the green/red arms. Writes shared `setup.confidencePct`.

---

## Sweet-spot definition (for labels, not a new optimizer)

The picked point **is** the sweet spot. Do not auto-solve a hidden utility unless you mark it as a suggestion:

- Optional ghost: **max E[return] on the live (solid) book** — a second, smaller sky ring + caption `best E[return] on book`.
- The desk can still pick any other dot (including leverage).

No “Apply” that writes H* or the swap book from this modal in v1. Close leaves the inspection; persist stays on the Liquidity tab.

---

## Locked style

Reuse **`docs/design/design-system-claude.md`**.

- Modal: `rounded-xl border border-slate-700 bg-slate-900` · `z-[200]` · `bg-black/60 backdrop-blur-sm`
- Sticky header: `border-b border-slate-800 bg-slate-900`
- Cards: 4-up · `text-[9px]` labels · `font-mono text-sm` values
- Chart section: `rounded-lg border border-slate-700 bg-slate-950 p-3`
- Controls: segmented track `border-slate-700 bg-slate-950/60` · Open emerald · Far rose · leverage `accent-emerald-400`
- Semantic: return emerald · risk amber-rose · E[return] sky · open arm emerald · far arm rose · Target Carry amber · Target VAR sky · CCY violet · Close ghost

---

## Sample point (EUR, 95%, Target Carry)

Origin: CFaR **$359K** · carry **$0** · E[return] **−$18K**.  
Sweet spot (open, book S −12.4): carry **+$40K** · CFaR **$412K** · E[return] **+$19K**.  
Far twin: carry **−$12K** · same CFaR **$412K** · E[return] **−$33K**.  
Amber horizontal at **+$40K**; gold rings on both arms; dashed tail beyond book.

---

## Problems to fix

1. Chart is buried under a dense point table — **remove the table**; chart is the picker.
2. Header is a wall of prose — chips + one helper line.
3. Selected state is a mono dump — promote to 4 cards (return, risk, E[return], S).
4. Leverage must visibly extend the dashed tail (the control that “did nothing”).
5. Open vs Far must be obvious on the chart and the S card (same notional, two Y).
6. Constraint cuts must read as the sweet-spot *guides*, not a second dataset.
7. Do not mix the funding swap into a liquidity-path sparkline if you add one later.

---

## Associated functionality (layout around it)

| Function | UI |
|----------|-----|
| `buildLiquidityLeftEndFrontier` | Arms, origin, `levered`, constraint hits |
| `frontierCarryDotsK` / `carryStepsToMaxK` | Leverage slider grid |
| `signedPeakStanding` / `bookCashCarryK` | Solid / dashed join |
| `LiquidityFrontierConstraint` | H/V cuts + rings |
| `probabilityWeightedReturnUsdM` | E[return] card |
| `liquidityFrontierDial` | Which cut + zoom |
| Click / ← → / Open–Far | Sweet-spot selection (`selKey`) |

**Out of scope:** persist to the book · edit H* / policy VAR · CFaR-tab `cfar-frontier.ts` · 3-objective Pareto · point table.

---

## Deliverables

1. Modal wire — header · 4 cards · chart · control toolbar (no table)
2. Chart zones — origin, solid/dashed arms, H/V cuts, rings, sweet-spot dot, tooltip
3. Control layout — arm · stepper/scrubber · leverage · (optional confidence)
4. What changed vs current (table gone, cards + toolbar)

---

## Prompt for Claude Design (paste)

```
Design “{CCY} — liquidity frontier” modal in a dark FX treasury Analytics desk.

RULES: Same slate/emerald/violet/amber/rose/sky kit · dense 9–11px ·
refinement only · no screenshots · no new theme

JOB: pick a sweet-spot combination of return and risk on the efficient
frontier. No data table — the chart and controls are the picker.

AXES: X = CFaR $K (risk). Y = Carry $K/yr (return).
Origin = section CFaR, carry $0. Same notional S:
  green solid = open cash (live book) · green dashed = leveraged open
  red solid = far hedge, cash+points · red dashed = leveraged far
Amber horizontal = Target Carry (same X, two Y).
Sky vertical = Target VAR (carry open vs far).
Gold rings = constraint hits. White ring = book join.
Sky filled dot = the picked sweet spot.
Optional thin sky overlay / card only: E[return] =
  Carry × 100% − CFaR × tail(90/95/99).

CHAPTERS (top → bottom)
1. Header chips: regime · dial (Target Carry / Target VAR / Min floor) ·
   book S · layers. One helper line. Close.
2. Four cards for the picked point: Return/Carry Y (emerald), Risk/CFaR X
   (amber), E[return] (sky), Exposure S (emerald open / rose far).
3. Full-width frontier chart — click a dot to pick. Hover tooltip:
   arm · S · carry · CFaR · E[return]. Distinct $K ticks.
4. Controls under the chart (no table):
   · Open / Far segmented (twin at same S)
   · Stepper ‹ i/n › + optional scrubber along the arm
   · Leverage slider: max cash-carry $K — extends dashed tail past book
   · Optional 90/95/99 — only rescales E[return], not the arms

FIX: delete the point table; stop the prose wall; make Open vs Far and
the sweet spot obvious; leverage must move the dashed tail; constraint
cuts are guides, not a second dataset.

DO NOT: 3rd axis · linear fake CFaR · interior 25/50/75 covers · persist
H* from the modal · invent a point grid.

OUTPUT: Modal wire · card layout · chart zones · control toolbar ·
Tailwind-class notes
```
