# Design brief + impl task — Trading desk

**New in-app surface** — same dark slate desk UI (`docs/design/design-system-claude.md`). No marketing layout, no light mode, no screenshots required.

**Job:** take an *approved* hedge / funding package and turn it into a live ticket: choose instrument → Price (Refinitiv IPA) → Confirm → blotter. Sizing stays on Analytics / Hedging Decision. Execution lives here.

**Code (target):**
- `components/test-mode/TradingDesk.tsx` — new tab body
- `components/test-mode/TradeTicketPanel.tsx` — extract / replace `BookHedgeModal` in `HedgingDecisionLayer.tsx`
- `components/test-mode/TradeBlotter.tsx` — live + scheduled tickets
- Wire: `app/dashboard/Simulator.tsx` (`SimulatorTab` + `ALL_TABS`) · `lib/desk-tabs.ts` · `WorkbenchFxDesk.tsx` · `WorkbenchGroupDesk.tsx`

**Reuse, do not fork:**
- `HedgeTicket` · `HedgeInstrument` · `HedgeIpaQuote` · `PreparedHedgeProfile` — `lib/test-mode/hedge-var.ts`
- `priceWithRefinitiv` — same session as Market data
- `varApprovalRequired` / `POLICY_VAR_LIMITS` — `lib/fx-buffer.ts`
- `HedgeApprovalStep` stays on Analytics Book / Approve. Trading never re-approves.

**Existing desk (do not replace):** Hedging Decision (structure, Δ, residual) · Analytics lenses · Live Ladder · FX Simulator book.

---

## Pipeline (locked)

```
Analytics (VaR / Carry / Liquidity)
  └─ Stage package  →  PreparedHedgeProfile.approvalStatus = draft
Book / Approve
  └─ Policy gate    →  pending | approved   (HedgeApprovalStep)
Hedging Decision
  └─ Structure / Δ / residual  (read + last-mile size tweaks)
Trading  ← THIS SURFACE
  └─ Queue of approved packages + ad-hoc ticket
  └─ Price (IPA) → Confirm book → HedgeTicket[]
Live book / Live Ladder / Risk Metrics
  └─ already consume bookedHedges
```

Hedging Decision **keeps** structure + residual. It **loses** the cramped `Book · {CCY}` modal and the inline “live / PENDING / Cancel” rows. Those move to Trading. Decision may deep-link `Open in Trading · {CCY}`.

---

## Product intent

One execution desk for the live FCY book. The trader sees:

1. **What is ready to trade** (approved packages, by lens)
2. **The ticket under the pencil** (pair, side, notional, instrument, tenor, strike, quote)
3. **What is already on** (blotter — live vs scheduled strip legs)

Same component on Workbench FX desk and Group desk. Hidden when the dashboard has no `hedging` decision layer (same rule as Hedging Decision + Live Ladder).

---

## Zone map (top → bottom)

| # | Zone | Job |
|---|------|-----|
| 1 | **Session strip** | Residual VaR · policy chip · last IPA time · CCY filter |
| 2 | **Queue** | Approved packages waiting to execute (one row per CCY · lens) |
| 3 | **Ticket** | The working ticket — Price / Reprice / Confirm |
| 4 | **Blotter** | Booked + scheduled tickets · cancel ticket / cancel strip |

```
┌ Session  Resid VaR $4.2M · Treasury can release · IPA 14:02 · [EUR][PLN][CAD][ALL] ┐
├ Queue ──────────────────────────────────────────────────────────────────────────┤
│ EUR  FX Risk   Strip · 4   Cover −21.60M   Carry +$41K   [Load ticket]          │
│ PLN  Cash Carry Bullet     Cover −8.40M    Carry +$12K   [Load ticket]          │
│ CAD  Liquidity  M1 spot    Cover +207.75M  Fund          [Load ticket]          │
├ Ticket · EURUSD ────────────────────────────────────────────────────────────────┤
│ Instrument [Spot][Forward][Option][Swap]   Tenor [1w][1m][3m][6m][1y]          │
│ Strike ATMF · ATM · 25Δ              Side SELL   Size 21.60M EUR  (auto)       │
│ IPA  1.08420 → 1.08110   Prem $82,400 · 0.381%   Vol 7.20% · Δ −25.0           │
│                              [Cancel]  [Price]  [Confirm book]                  │
├ Blotter ────────────────────────────────────────────────────────────────────────┤
│ LIVE   EUR  FWD 1m   SELL 21.60M   1.08110   VaR $180K   [Cancel]               │
│ SCHED  EUR  FWD 3m   SELL  7.20M   —         strip L2    [Cancel strip]         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Zone detail

### 1 · Session strip

4-up metric chips (design-system card rhythm):

| Chip | Source | Tint |
|------|--------|------|
| Resid VaR | same as Decision / Analytics after booked | rose |
| Policy | `varApprovalRequired(residVaR)` — who / whether Trading can confirm | violet if Treasury; amber if DoF+ |
| Last quote | newest `ipaQuote` timestamp on the working ticket · `—` if none | sky |
| Working CCY | segmented CCY filter · `ALL` + book CCYs | violet on |

Chapter label: `1 · Session`.

### 2 · Queue

One table, approved packages only (`approvalStatus === 'approved'` or legacy missing). Draft / pending stay on Book / Approve — do not list them here.

| Col | Content | Tint |
|-----|---------|------|
| CCY | mono | violet chip |
| Lens | FX Risk · Cash Carry · Liquidity | slate / sky / fuchsia |
| Structure | `Strip · N` or `Bullet` | slate |
| Cover | signed M FCY | emerald / rose |
| Carry | signed `$K` or `—` | emerald / rose |
| Action | `Load ticket` primary | emerald CTA |

Empty: dashed panel — “Approve a package on Analytics Book, then it lands here.”

Click **Load ticket** → fills zone 3 from `proposeBookHedge` / first live strip leg (same helpers Decision uses today). Does not book.

### 3 · Ticket

This is today’s `BookHedgeModal`, expanded to a **section** (not a `max-w-md` dialog). Modal is allowed only as a narrow confirm if the blotter action needs a second click.

| Field | Rule |
|-------|------|
| Pair | `{CCY}USD` / `USD{CCY}` via `usdMarketPair` — read-only |
| Side | Sell when `amountLocalM ≥ 0` (long FCY exposure) · Buy otherwise — read-only, from book sign |
| Size | auto from approved package / Decision % · show `fmtLocal` · v1 not freely typed (prevents silent desync with residual). Ad-hoc ticket (below) is the typed path |
| Instrument | `Spot` · `Forward` · `Option` · `Swap` (Soon until `HedgeInstrument` grows) |
| Tenor | hidden for Spot · `VAR_HORIZON_OPTIONS` chips otherwise |
| Strike | Option only — ATMF / ATM / 25Δ / 10Δ + free input (same as modal) |
| Quote | IPA strike · spot → outright · premium $ + % · vol / Δ |
| Price | sky secondary CTA · busy = `Pricing…` · success clears error |
| Confirm book | emerald primary · **disabled until a successful Price** *or* trader ticks “Book unpriced” (amber) |
| Book unpriced | amber checkbox · writes ticket without `ipaQuote` · must be explicit |

Ad-hoc ticket (secondary, under the ticket header): `New ticket` ghost → pick CCY from the book → type size (M FCY) → same Price / Confirm. Still writes a `HedgeTicket`. Restricted-currency ops are **not** P&L KPI — if the book marks a CCY restricted, badge the ticket `restricted · not trading P&L` (amber) and do not treat Confirm as a carry win.

Policy: if residual VaR after this ticket would cross the next approval threshold, Confirm stays disabled and the session strip shows who must sign. Do not invent a second approval UI.

### 4 · Blotter

`overflow-x-auto` · `min-w-[640px]` · `text-[10px] font-mono` body.

| Col | Notes |
|-----|--------|
| Status | `live` emerald · `scheduled` amber (`HedgeTicketStatus`) |
| CCY | |
| Ticket | `ticketLabel()` — SELL/BUY · instrument · tenor |
| Settle | `maturityLabel` |
| Rate | IPA outright or `—` |
| Cover | signed M |
| VaR | `$K` |
| Action | Cancel · Cancel strip |

Book / live package row: `bg-emerald-500/[0.08]`. Row hover `hover:bg-slate-800/50`.

Cancel uses existing `removeHedgeTicketOrStrip`. No silent delete.

---

## Locked style

Reuse **`docs/design/design-system-claude.md`**. This is an Analytics / Decision sibling — **slate-\*** classes, not the simulator `.sim-dark` gray remap.

- Page sits inside Simulator `<main>` — no new shell
- Panel `rounded-xl border border-slate-700 bg-slate-900 p-4`
- Section `rounded-lg border border-slate-700 bg-slate-950/40 p-3`
- Chapter labels `text-[9px] font-semibold uppercase tracking-wide text-slate-600`
- Metric labels `text-[9px] uppercase tracking-wide text-slate-500`
- Figures `font-mono text-sm font-semibold tabular-nums`
- Semantic: risk rose · cover / IPA sky · confirm emerald · schedule amber · CCY violet · CP orange
- Primary = Confirm book (emerald) · Price = sky · Ghost = Cancel
- `transition-colors` only

**Do not** author this surface in `gray-*` / `bg-white` (that remap is FX Simulator only).

---

## Sample data (mockups)

Book: **EUR · PLN · CAD**. Resid VaR `$4.2M` → Treasury. Exposure period 3m. Policy 95%.

| CCY | Lens | Structure | Cover | Carry |
|-----|------|-----------|-------|-------|
| EUR | FX Risk | Strip · 4 | −21.60M | +$41K |
| PLN | Cash Carry | Bullet M6 | −8.40M | +$12K |
| CAD | Liquidity | M1 spot | +207.75M | — |

Working ticket EUR: Forward · 1m · SELL 21.60M · IPA 1.08420 → 1.08110 · prem n/a · Confirm enabled.

Blotter: one live EUR FWD 1m; three scheduled EUR strip legs; empty PLN/CAD.

---

## Problems this surface fixes

1. **Book is a cramped modal inside Decision** — execution and structure fight for the same fold
2. **Confirm book works without a quote** — silent unpriced tickets
3. **No queue** — trader hunts Analytics → Approve → Decision to find what is executable
4. **No blotter** — live vs scheduled is a nested table footnote
5. **Swap / funding tickets have no home** — liquidity programme is priced on Analytics, executed nowhere
6. **10 flat Simulator tabs** — Trading must sit next to Hedging Decision, not at the end of the row
7. **Restricted CCY can look like a P&L trade** — policy forbids that

---

## Implementation task

### Phase A — tab + shell (no new pricing)

1. Add `'trading'` to `SimulatorTab` and `ALL_TABS` **immediately after** `hedging` (`label: 'Trading'`).
2. `CURRICULUM_TAB_LABELS.trading = 'Trading'`.
3. `hiddenTabsForLayers`: hide `trading` whenever `hedging` is hidden (same `decision.includes('hedging')` gate). Curriculum simplified book must **show** Trading (do not add it to the simplified-book hide list).
4. New `tradingPanel?: ReactNode` on `Simulator`, same `cloneElement` live-injection pattern as `hedgingPanel` (`bookRows`, `forecastProfile`, `fcyComputed`, `r_USD`).
5. `TradingDesk` empty-state shell: session strip + dashed queue + dashed blotter. No ticket until a package is loaded.

### Phase B — ticket + IPA (extract, don’t copy)

1. Lift `BookHedgeModal` (+ `runPrice`, strike chips, `BOOK_INSTRUMENTS`) out of `HedgingDecisionLayer.tsx` into `TradeTicketPanel.tsx`.
2. Decision **Send / Book** becomes `onOpenTrading(ccy)` (or loads the ticket via lifted state). Do not leave two Price implementations.
3. Confirm writes through existing `onBookedHedgesChange` / `onBookHedge` — same `HedgeTicket` shape, `newHedgeTicketId()`, strip merge helpers.
4. Gate Confirm: quote present **or** `bookUnpriced === true`.
5. Instrument `Swap` chip visible, `Soon` / `disabled` until `HedgeInstrument` includes `'swap'`. Do not invent a parallel ticket type in v1.

### Phase C — queue + blotter

1. Queue reads `releasedPreparedByCcy(preparedByCcy)` only.
2. Blotter reads `bookedHedges` (live + scheduled). Cancel = `removeHedgeTicketOrStrip`.
3. Session Resid VaR = same engine Decision already shows (`buildHedgeVarSummary` / booked residual). Do not recompute a third VaR.

### Phase D — wire hosts

Pass `tradingPanel={<TradingDesk … />}` from:

- `components/workbench/WorkbenchFxDesk.tsx`
- `components/workbench/WorkbenchGroupDesk.tsx`
- `app/test/tasks/Task01App.tsx` (both Simulator mounts)

Shared props: `bookedHedges` · `onBookedHedgesChange` · `preparedByCcy` · `varSetup` · `risk` / rows · `marketRatesByCcy` · `ratesScopeId` · `onBookHedge`.

### Tests

- `lib/desk-tabs.ts` — hiding hedging also hides trading; showing hedging shows trading.
- Ticket confirm without quote is rejected unless `bookUnpriced`.
- Queue excludes `draft` / `pending`.
- Blotter cancel of a strip id removes every leg with that `stripId`.
- Do **not** migrate pre-existing native-float ticket math to Decimal.js in this change (project carve-out). New arithmetic on money must use Decimal.js.

### Out of scope (v1)

- FXAll RFQ / dealer panel (div note only — no adapter in this repo)
- NDF / exotic structures (TARF always needs FX Lead — do not add a chip)
- Editing notional on an approved package (ad-hoc ticket is the typed path)
- New approval UI, new VaR engine, new theme
- Changing `helm/` · `.github/` · `Dockerfile` · `values.yaml`

---

## Acceptance

- [ ] Trading tab sits beside Hedging Decision on Workbench + Task 01 when `hedging` is on
- [ ] Tab hidden when dashboard has no hedging layer
- [ ] Approved EUR package → Load ticket → Price → Confirm → row on blotter + residual VaR moves
- [ ] Draft / pending packages do not appear in the queue
- [ ] Confirm disabled with no quote until “Book unpriced” is checked
- [ ] Cancel strip removes the whole roll; Decision / Live Ladder / Risk Metrics stay in sync (same `bookedHedges` array)
- [ ] Visual: slate desk kit, 9–11px, mono figures, no `gray-*` / marketing gradient
- [ ] Restricted CCY ticket shows the non-P&L badge
- [ ] `fx-review` clean on the diff (no new secrets, no new float money math)

---

## Deliverables (design)

1. **Zone wire** — session · queue · ticket · blotter (ASCII fine)
2. **Ticket anatomy** — instrument / tenor / strike / quote / CTA states
3. **Queue + blotter column rhythm** + empty / disabled / unpriced states
4. **What moved** — bullets vs current `BookHedgeModal` + Decision nested rows
5. **What changed** — remap-safe? No: slate kit classes only

---

## Prompt for Claude Design (paste)

```
Design a Trading desk tab for a dark FX treasury workbench
(same kit as docs/design/design-system-claude.md).

SURFACE: execution only. Analytics stages a hedge/funding package;
Book/Approve releases it; Hedging Decision keeps structure + residual;
Trading prices and books the ticket onto the live blotter.

HARD CONSTRAINT
- Slate/emerald/violet/amber/rose desk kit · 9–11px · font-mono figures
- Panels rounded-xl border-slate-700 bg-slate-900
- Sections rounded-lg bg-slate-950/40
- Do NOT use gray-* / bg-white (those belong to the simulator remap)
- No marketing UI, no light mode, no new brand

ZONES (top → bottom)
1. Session strip — Resid VaR (rose) · policy chip (violet/amber) ·
   last IPA time (sky) · CCY filter (violet)
2. Queue — approved packages only: CCY · lens (FX Risk / Cash Carry /
   Liquidity) · Strip·N or Bullet · signed cover M · carry $K ·
   Load ticket. Empty: “Approve a package on Analytics Book.”
3. Ticket — pair read-only · side from book sign · size auto ·
   instrument Spot / Forward / Option / Swap(Soon) · tenor chips ·
   option strike ATMF/ATM/25Δ · IPA quote readout ·
   Ghost Cancel · sky Price · emerald Confirm
   Confirm disabled until Price succeeds, unless “Book unpriced” (amber)
4. Blotter — live (emerald) vs scheduled (amber) · ticket label ·
   settle · outright · cover · VaR $K · Cancel / Cancel strip

SAMPLE
EUR Strip·4 cover −21.60M carry +$41K loaded as Forward 1m SELL 21.60M
IPA 1.08420 → 1.08110. Resid VaR $4.2M (Treasury). PLN + CAD still queued.

OUTPUT
1) Zone wire
2) Ticket field + CTA states (priced / pricing / unpriced / policy-blocked)
3) Queue + blotter columns + empty states
Refinement kit — no new theme.
```
