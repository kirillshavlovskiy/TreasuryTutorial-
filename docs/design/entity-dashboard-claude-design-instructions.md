# Claude Design instructions — Entity + per-asset dashboard

**Paste this whole file into Claude Design.**  
Product: Treasury Workbench (FX / risk desk).  
Full brief: `docs/design/entity-onboarding-claude-design.md`  
Design kit: `docs/design/design-system-claude.md`

---

## Rules (non-negotiable)

- Dark **desk** UI — slate / emerald / violet / amber / rose. **Not** marketing.
- Dense **9–11px** type · `font-mono` for tickers and figures.
- **Icon on top · label under** · equal cards · tap to select.
- **No settings** during create (no limits, Tf, banks, book seed, Model 1–3).
- Cards only for selection — no decorative card grids.
- Refinement kit one-liner:

```
Same slate/emerald/violet/amber/rose desk kit · panels rounded-xl border-slate-700
bg-slate-900 · sections rounded-lg bg-slate-950/40 · 9–11px type · font-mono
figures · semantic: risk rose · carry emerald · cover sky · schedule amber ·
CCY violet · CP orange · refinement only · no marketing UI
```

---

## Architecture

| Concept | Rule |
|---------|------|
| **Entity** | Client / legal book. Multi-select which **risk assets** apply. |
| **Dashboard** | Exactly **one** risk asset under that entity. Analysis + optimization / hedging for that asset only. |
| **Protect** | Per dashboard (not on entity). |
| **Optimize** | Per dashboard — frameworks / metrics. |
| **Cash buffer** | Per dashboard — LP buffer layers behind the simulator grid. |
| **Tickers** | **Last** step on dashboard create — currencies or asset tickers. |

```
Add entity → Entity home → Create dashboard (× per asset class)
  1 Risk asset (ONE)
  2 Protect (multi)
  3 Optimize (multi)
  4 Cash buffer layers (multi, may be empty)
  5 Tickers (multi) ← last
  → Open desk for that asset
```

---

## Screen A — Add entity

**Layout**
- Modal / panel `max-w-3xl` · dark slate
- Top: **Entity name** (single text field, required)
- Body: one icon-card grid (multi-select)
- Bottom: **Create entity** (disabled until name + ≥1 asset)

**Risk asset cards** (icon + label under)

| Label | Badge |
|-------|--------|
| Currencies | Live |
| Interest rates | Live |
| Bonds | Soon |
| Investments | Soon |
| Commodities | Soon |
| Real assets | Soon |

**Do not** ask Protect / Optimize / Tickers here.

**After Create** → Screen C (Entity home).

---

## Screen B — Create dashboard (under open entity)

**Entry:** Entity home → **New dashboard** or asset tile → **Create**.  
**Top:** 5-step stepper · Back / Continue / Create.  
**No** entity rename here.

### Step 1 — Risk asset (SINGLE select)

Show **only** assets enabled on the entity. Exactly one.

Helper: “One dashboard · one risk asset · analysis & hedging.”

### Step 2 — Protect (MULTI)

Icon cards · label under:

- Asset value  
- Cash flow  
- Liquidity  
- Credit  
- Earnings  

≥1 required.

### Step 3 — Optimize (MULTI)

Frameworks for **this** asset:

| Label | Badge |
|-------|--------|
| VaR | Live |
| CFaR | Live |
| EaR | Soon |
| DV01 | Soon |
| Greeks | Soon |
| Factor model | Soon |
| Credit | Soon |
| Hedge / carry | Live (Currencies) |

Mute + Soon when N/A for the chosen asset. ≥1 Live preferred to Continue.

### Step 4 — Cash buffer layers (MULTI)

Separate grid from step 3 — these size the cash buffer on the simulator grid, they are not risk frameworks. Fixed labels:

| Label | Meaning |
|-------|---------|
| Min Floor | Hard per-currency minimum cash floor |
| Payout Buffer | Forecast-uncertainty (σ_P) margin on payouts |
| Carry Target | Rate-differential carry optimisation |
| Portfolio VaR | Diversified VaR budget across currencies |

- Currencies / Interest rates only — mute whole step (`Soon`) for other assets
- **Zero picks allowed** → Continue stays enabled; desk opens without the Layer Setup tab

### Step 5 — Tickers (MULTI) — LAST

Depends on step-1 asset:

| Asset | Example tickers |
|-------|-----------------|
| Currencies | EUR · PLN · GBP · USD · … |
| Interest rates | SOFR · EURIBOR · … |
| Commodities | XAU · WTI · … |
| Bonds / Investments / Real assets | Tickers / codes (Soon lists OK) |

- Compact **code chips** (label = ticker) · same selected treatment as cards  
- Optional mono **search** above grid  
- ≥1 ticker required  
- Then **Create dashboard** → open desk scoped to those tickers + frameworks  

---

## Desk on create (existing shell — do not redesign)

| Tab | Shown when |
|-----|------------|
| **FX Simulator** (book grid) | always |
| **Layer Setup** | ≥1 cash buffer layer (step 4) |
| **Analytics** (VaR · Cash Carry · CFaR) | ≥1 Live framework (step 3) |
| **Hedging Decision** + **Live Ladder** | Hedge / carry picked |
| **Liquidity** | Cash flow / Liquidity in Protect |
| **IR Profile** | Interest rates asset or DV01 |

---

## Screen C — Entity home

```
Entity · Acme Treasury
Risk assets: Currencies · Interest rates · Commodities

┌ Currencies      ┐  ┌ Interest rates ┐  ┌ Commodities ┐
│ Dashboard · on  │  │ No dashboard   │  │ Soon        │
│ EUR · PLN · GBP │  │ [Create]       │  │             │
│ VaR · CFaR      │  └────────────────┘  └─────────────┘
│ [Open]          │
└─────────────────┘
[+ New dashboard]
```

- One tile per entity risk asset  
- Has dashboard → ticker chips + framework chips + **Open**  
- No dashboard → **Create**  
- Switching tile / Open = switch risk-asset desk  

---

## Card / chip UI spec

```
┌─────────────┐
│    [icon]   │   ← simple line icon ~28–32px
│   Currencies│   ← label under, 11px semibold, centered
│    Live     │   ← optional 9px muted
└─────────────┘
```

| State | Treatment |
|-------|-----------|
| Idle | `border-slate-700 bg-slate-950/40` · icon slate-300 |
| Selected | sky or violet border + tint · check corner |
| Soon | selectable for intent · muted badge |
| Disabled | opacity 40 · not tappable |
| Ticker chip | code as label (EUR) · same selected border |

Grid: 3–6 columns · equal size · `gap-2`/`gap-3`.

---

## Empty / blocked states

- Add entity: empty name or no risk asset → Create disabled  
- Dashboard step 1: no asset selected → Continue disabled  
- Step 2 / 3 / 5: need ≥1 pick each  
- Step 4: zero picks allowed — Continue stays enabled  
- Entity with no assets → prompt to edit entity (out of scope for v1 wire)  

---

## Output checklist (Claude Design)

Deliver wires for:

1. **Add entity** — name + risk-asset icon grid  
2. **Entity home** — asset tiles (with / without dashboard)  
3. **Create dashboard** — steps 1–5 (asset · protect · optimize · **cash buffer** · **tickers**)  
4. **Card component** — idle / selected / Soon  
5. **Ticker chip row** — Currencies example (EUR PLN GBP USD)  
6. **Empty states** — disabled Continue/Create + step-4 zero-pick pass-through  

Do **not** design limit forms, book-seed tables, the FX Simulator grid, the Layer Setup tab, or the full Analytics desk in this pass — those exist and stay as they are.
