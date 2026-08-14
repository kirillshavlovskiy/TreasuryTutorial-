# Design brief — Entity + per-asset dashboard creation

**New in-app flow** — same dark slate desk UI (`docs/design/design-system-claude.md`). No marketing funnel, no screenshots required.

**Claude Design (paste):** `docs/design/entity-dashboard-claude-design-instructions.md`

**Code (target):**  
- `EntityOnboardingWizard.tsx` — create entity + risk-asset universe  
- `DashboardCreateWizard.tsx` — under an open entity, create **one dashboard = one risk asset**  
**Related:** `RiskPerspectiveSelector` · `VarAnalyticsPanel` · Analytics tabs (VaR · Cash Carry · CFaR · DV01 · Greeks)  
**Existing desk (do not replace):** `Simulator` tabs — FX Simulator (`UnifiedSimulator`) · Layer Setup (`LayeredBufferAnalysis`) · `OPT_METRICS` / `metricsToLayers()` in `lib/workspace-store.ts`

---

## Model (decide)

| Concept | Rule |
|---------|------|
| **Entity** | Client / legal book. Owns a set of **risk assets** it deals with. |
| **Dashboard** | Exactly **one** risk asset. Analysis + optimization / hedging for that asset only. |
| **Optimization metrics** | Chosen **per dashboard** (not once for the whole entity). |
| **Protect pickup** | Chosen **per dashboard** (what we defend for this asset). |
| **Cash buffer layers** | Chosen **per dashboard** — the LP buffer stack that drives FX Simulator + Layer Setup. |
| **Tickers** | Chosen **last** on dashboard create — currencies (EUR, PLN…) or asset tickers for that risk class. |

So: open entity → create dashboard(s) under it → each dashboard is Currencies **or** Rates **or** Bonds … with its own Protect + Optimize + buffer layers + ticker set.

---

## Flow overview

```
Add entity
  └─ name + which risk assets apply (multi-select icons)
       └─ Open entity
            └─ Create dashboard (repeat per asset class)
                 ├─ 1. Risk asset — pick ONE from entity’s enabled assets
                 ├─ 2. Protect — multi-select pickup icons
                 ├─ 3. Optimize — multi-select frameworks for THIS asset
                 ├─ 4. Cash buffer layers — multi-select LP buffer stack
                 └─ 5. Tickers — currencies or asset tickers (multi-select)
                      └─ Open that asset’s desk (simulator / hedging / analytics)
```

No limits · no book seed · no banks during create. Settings later on the desk.

---

## A — Create entity (short)

**Entry:** Workbench → **Add entity**  
**Header:** Entity name (required)  
**One step:** **Risk assets** — multi-select icon cards (which assets are risky *for this entity*)

| Card | Notes |
|------|--------|
| **Currencies** | Live desk today |
| **Interest rates** | Live (carry / deposits) |
| **Bonds** | Soon |
| **Investments** | Soon |
| **Commodities** | Soon |
| **Real assets** | Soon |

**Create** → entity home: list of enabled assets · **Create dashboard** CTA per asset (or one shared CTA that asks which asset).

Entity does **not** pick Protect / Optimize — those wait for dashboard creation.

---

## B — Create dashboard (under open entity)

**Entry:** Entity home → **New dashboard** · or click an enabled asset tile → **Create dashboard**.  
**Constraint:** one risk asset per dashboard. If that asset already has a dashboard, offer **Open** instead of duplicate (or allow named variants later — v1 = one dashboard per asset).

### Card pattern (all steps)

Icon on top · **label under** · `Live` / `Soon` · multi-select where noted · no extra settings.

```
┌─────────────┐
│    [icon]   │
│   Currencies│
└─────────────┘
```

### Step 1 — Risk asset (single select)

Headline: **Dashboard asset** · helper: “One dashboard · one risk asset · analysis & hedging.”

Show **only** assets enabled on the entity. Tap **one**.

| If entity enabled… | Card |
|--------------------|------|
| Currencies | Currencies |
| Interest rates | Interest rates |
| Bonds | Bonds |
| … | … |

Continue requires exactly one selection.

### Step 2 — Protect (pickup, multi-select)

Headline: **Protect** · for *this* asset only.

| Card | Meaning |
|------|---------|
| **Asset value** | Fluctuation in holdings |
| **Cash flow** | Available cash flow |
| **Liquidity** | Funding / settlement |
| **Credit** | Counterparty / credit |
| **Earnings** | Earnings volatility |

≥1 required.

### Step 3 — Optimize (frameworks, multi-select)

Headline: **Optimization frameworks** · metrics & hedging analytics for *this* asset.

| Card | Hook |
|------|------|
| **VaR** | Market / position risk |
| **CFaR** | Cash-flow at risk |
| **EaR** | Earnings at risk |
| **DV01** | Rate sensitivity |
| **Greeks** | Option / greek risk |
| **Factor model** | Factor / portfolio risk |
| **Credit** | Credit optimization metrics |
| **Hedge / carry** *(optional Live for Currencies)* | Cash Carry · hedge package |

Framework availability can depend on asset (e.g. Greeks muted for Bonds until live; DV01 primary for Interest rates). Show all cards; disable + `Soon` when N/A.

≥1 **Live** framework required to Continue (prefer ≥1 Live).

### Step 4 — Cash buffer layers (multi-select)

Headline: **Cash buffer** · helper: “Which layers size the cash buffer on the simulator grid.”

Existing `OPT_METRICS` — labels and layer ids are fixed, do not rename:

| Card | Layer id | Meaning |
|------|----------|---------|
| **Min Floor** | `floorH` | Hard per-currency minimum cash floor |
| **Payout Buffer** | `sigmaP` | Forecast-uncertainty (σ_P) margin on payouts |
| **Carry Target** | `carryOptim` | Rate-differential carry optimisation |
| **Portfolio VaR** | `portfolioDiv` | Diversified portfolio VaR budget across currencies |

- Currencies / Interest rates only — mute the whole step with `Soon` for other assets
- Zero picks allowed → desk opens with an unlayered book and **no Layer Setup tab**
- ≥1 pick → `metricsToLayers()` seeds `initialActiveLayers` and the **Layer Setup** tab is shown

### Step 5 — Tickers (last step, multi-select)

Headline: **Currencies / tickers** · helper depends on step-1 asset.

| Dashboard asset | Step-4 content |
|-----------------|----------------|
| **Currencies** | ISO currency chips/cards — e.g. EUR · PLN · GBP · USD · … (common set + search/add) |
| **Interest rates** | Rate / curve tickers — e.g. SOFR · EURIBOR · … or currency of the rate book |
| **Bonds** | Bond tickers / ISINs (Soon — searchable list) |
| **Investments** | Security tickers |
| **Commodities** | Commodity tickers — e.g. XAU · WTI |
| **Real assets** | Asset codes / labels |

**UI:** same icon/chip pickup — ticker **code as label** under a small asset glyph (or code-only chip). Multi-select · ≥1 required · optional search field above the grid (`font-mono` typeahead) — still no sizing/limits settings.

```
┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐
│ EUR │ │ PLN │ │ GBP │ │ USD │
└─────┘ └─────┘ └─────┘ └─────┘
```

**Create dashboard** → open that asset’s desk scoped to selected tickers.

---

## Desk tab set on open

The dashboard opens the existing `Simulator` shell — the picks above only decide tab visibility. Nothing here replaces the simulator grid.

| Tab | Shown when |
|-----|------------|
| **FX Simulator** | always (the book grid — never hidden) |
| **Layer Setup** | ≥1 cash buffer layer picked (step 4) |
| **Analytics** (VaR · Cash Carry · CFaR) | ≥1 Live risk framework picked (step 3) |
| **Hedging Decision** + **Consolidated Live Ladder** | Hedge / carry picked |
| **Market data** | with Analytics |
| **Liquidity** | Cash flow / Liquidity picked in Protect (step 2) |
| **IR Profile** | Interest rates asset, or DV01 picked |
| **Monte Carlo** | `Soon` |

---

## Entity home (after create)

```
Entity · Acme Treasury
Risk assets: Currencies · Interest rates · Commodities

┌ Currencies     ┐  ┌ Interest rates ┐  ┌ Commodities   ┐
│ Dashboard · ●  │  │ No dashboard   │  │ Soon          │
│ EUR · PLN · GBP│  │ [Create]       │  │               │
│ VaR · CFaR     │  └────────────────┘  └───────────────┘
│ [Open]         │
└────────────────┘
[+ New dashboard]
```

- One row/tile per entity risk asset  
- If dashboard exists: **ticker chips** + frameworks + **Open**  
- If not: **Create dashboard**  
- Switching dashboard = switching risk asset context for analysis / optimization / hedging  

---

## Data shape (conceptual)

```ts
Entity {
  name: string
  riskAssets: RiskAssetId[]  // multi
}

Dashboard {
  entityId: string
  riskAsset: RiskAssetId     // exactly one
  protectGoals: ProtectId[]  // multi
  optimizeFrameworks: FrameworkId[]  // multi
  bufferLayers: OptMetric[]  // multi — existing OPT_METRICS ids (step 4)
  tickers: string[]          // multi — CCY codes or asset tickers (step 5)
}
```

`bufferLayers` reuses the existing `OptMetric` union from `lib/workspace-store.ts` and feeds `metricsToLayers()` → `Simulator.initialActiveLayers`. Do not invent a parallel layer model.

---

## Locked style

Reuse **`docs/design/design-system-claude.md`**.

- Icon + label under · equal cards · selected sky/violet  
- Entity create = 1 grid · Dashboard create = **5** short steps (asset → protect → optimize → **buffer** → **tickers**)  
- No forms beyond entity name + optional ticker search  
- Avoid: one global Optimize pick for the whole entity · skipping tickers on create · mixing buffer layers into the Optimize framework grid  

---

## Prompt for Claude Design (paste)

```
Design entity + dashboard creation for a dark FX treasury workbench
(same kit as docs/design/design-system-claude.md).

ARCHITECTURE
- Entity = client; multi-select which risk assets apply.
- Dashboard = exactly ONE risk asset under that entity
  (analysis + optimization / hedging for that asset only).
- Protect + Optimize metrics are chosen PER DASHBOARD, not on entity.

A) ADD ENTITY (simple)
- Header: entity name
- One grid of icon cards (label under icon), multi-select:
  Currencies · Interest rates · Bonds · Investments · Commodities · Real assets
- Create → entity home (tiles per asset)

B) CREATE DASHBOARD (under open entity) — 5 steps, icon/chip cards only
1. Risk asset — SINGLE select from entity’s enabled assets only
2. Protect — multi-select: Asset value · Cash flow · Liquidity · Credit · Earnings
3. Optimize — multi-select frameworks for THIS asset:
   VaR · CFaR · EaR · DV01 · Greeks · Factor model · Credit
   (Live vs Soon; asset may mute some cards)
4. Cash buffer layers — multi-select, separate grid from step 3:
   Min Floor · Payout Buffer · Carry Target · Portfolio VaR
   (Currencies / Interest rates only; whole step muted Soon otherwise;
    zero picks allowed). These size the cash buffer on the simulator grid.
5. Tickers (LAST) — multi-select currencies or asset tickers for the
   chosen risk asset (e.g. Currencies → EUR PLN GBP; Commodities → XAU WTI).
   Optional mono search; ≥1 ticker required. Then Create → desk.

DESK ON CREATE
Opens the existing simulator shell: FX Simulator grid always present;
Layer Setup tab only when ≥1 buffer layer; Analytics/Hedging tabs from step 3.

ENTITY HOME
Tiles: one per risk asset · Open or Create · show ticker chips + framework chips

CARD UI
Icon on top · label under · Live/Soon · selected border tint · no settings forms
Ticker step: compact code chips (EUR, PLN…) same selected treatment

OUTPUT
1) Add-entity wire
2) Entity home tiles
3) Create-dashboard 5-step wires (incl. buffer-layer grid + ticker grid)
4) Empty states (no asset; no protect/optimize; no ticker)
```
