# Simple Sigma — Digital Treasury Platform

> Comprehensive solution description. Synthesized from the codebase (`app/`, `components/`, `lib/`) and the project knowledge base (`.claude/rules/project/decisions.md`, `context.md`, and the department/division policy docs under `.claude/rules/dept/` and `.claude/rules/div/`).

---

## 1. What it is

**Simple Sigma** is an interactive Treasury workbench that turns the FX Team's spreadsheet-based FX exposure and liquidity models into a live, policy-governed web application. It lets the FX desk model multi-currency cash buffers, interest-rate carry, swap restructuring, and hedging decisions in one VaR-governed view — replacing manual Excel recalculation with a real-time, auditable simulator.

It is built as a **Next.js (App Router) + TypeScript** application, deployed as a containerized service on the platform (Helm/ArgoCD), with Google OAuth (NextAuth) gating access to a per-user workspace.

The product tagline on the landing page frames its purpose directly: *"Size FX buffers with confidence… an interactive treasury workbench for modelling multi-currency cash buffers, interest-rate carry and hedging decisions — all inside a single VaR-governed view."*

---

## 2. Business problem it solves

Treasury's FX Team (division mission: *"Manage FX exposure across 150+ currencies, implement hedging strategies, and build tooling to automate FX risk management"*) must continuously answer, per currency:

1. **How much FCY cash should we hold** in the Liquidity Pool (LP) vs. sweep to USD? (liquidity sufficiency vs. opportunity cost)
2. **How large should the restructuring FX swap be** to fund that target without changing net FX exposure?
3. **Is the currency EARN CARRY or PAY CARRY** relative to the USD LP rate, and how should that bias the buffer up or down?
4. **What is the aggregate portfolio Value-at-Risk (VaR)** across all currencies, and does it stay inside Treasury policy limits ($5M / $10M / $20M approval thresholds)?
5. **What hedge (spot / forward / option) should be executed** given the carry direction and pipeline needs?

Previously this lived in Excel models (Time Structuring, LP Liquidity Analysis, Std Deviation Model Daily, Loss Fraction VAR) with hardcoded, uniform assumptions (e.g. a fixed minimum cash threshold `H = 100,000` for every currency regardless of size or volatility). Simple Sigma implements the corrected, dynamic version of that model as executable, tested TypeScript, and wraps it in a UI so traders can manipulate assumptions and immediately see the effect on every downstream number.

---

## 3. Core financial model

The engineering decisions behind the model are fully recorded in `.claude/rules/project/decisions.md`. The platform implements the following chain, evolved through several iterations of debate and correction:

### 3.1 Dynamic minimum cash threshold (H)

Early iteration — **VaR + IR carry proxy**:

```
H = MAX(H_min, |C + D| × σ_daily × √21 × z₉₅ × (1 + carry_rate × β_IR))
```

- `C + D` — net FX position (spot + forward)
- `σ_daily × √21 × z₉₅` — the 1‑month, 95%-confidence VaR factor
- `(1 + carry_rate × β_IR)` — an IR-carry uplift multiplier, material for EM currencies (TRY: +37%) and negligible for DM currencies (<2%)

This subsumed three original design options (pure VaR-FCY proxy, combined VaR+carry, and LP-buffer parity) into a single formula, with a calibrated 25-currency parameter table (σ, carry, β_IR).

**This was later superseded.** The team determined that FX volatility (σ) should *not* drive the liquidity threshold at all:

> *"H redefined — interest-rate optimization, not FX risk proxy… When EUR depreciates, the EUR balance is unchanged — only the USD equivalent falls… VAR belongs in the Loss Fraction sheet (USD P&L limits per policy), not in the liquidity threshold column."*

### 3.2 Optimal buffer formula (current model)

```
H* = MAX(H_min, P × (1 + σ_P × Φ⁻¹(1 − Δr / r_OD)))
```

Where `P` = expected FCY payout, `σ_P` = forecast uncertainty, `Δr = r_USD − r_FCY` (carry differential), `r_OD` = overdraft facility rate. This is a genuine cost-minimization: total cost = opportunity cost of holding FCY + expected overdraft cost, minimized at `H*`. Currencies where FCY yield exceeds USD yield (`Δr < 0`, e.g. GBP, AUD, MXN, TRY) should hold **maximum** buffer — the carry is profitable NWC. Currencies paying negative carry (EUR, JPY, CHF) should hold minimum buffer and tolerate occasional overdraft.

### 3.3 Layered buffer composition

Rather than a single opaque formula, the buffer is decomposed into four **independently toggleable layers**, each mapped to a UI control:

| Layer | Purpose |
|---|---|
| **Safety Margin** (`sigmaP`) | 95%-confidence cushion against payout forecast error |
| **Carry Adjustment** (`carryOptim`) | Shifts buffer up for EARN-carry currencies, down for PAY-carry |
| **Minimum Floor** (`floorH`) | Hard per-currency floor — never lets the buffer go to zero |
| **Portfolio Diversification VaR** (`portfolioDiv`) | Caps the *aggregate* cross-currency VaR against the policy limit, using a 14×14 empirical correlation matrix so genuinely diversifying currencies (e.g. JPY vs. EM) aren't penalized as if fully correlated |

The portfolio VaR layer is deliberately the **last** layer: it "fills the limit with overlay VaR" — scaling the *discretionary carry overlay* (not pre-existing holdings) by a single factor `s` per the policy VaR budget, never liquidating base holdings to satisfy a limit.

### 3.4 FX swap restructuring sizing

The near-leg of the restructuring swap is sized to satisfy two constraints simultaneously (cash maintenance + position neutralization), taking the binding one:

```
I (near leg) = MAX(H − (F + G), −(C + D))
J (far leg)  = −I
```

Swap legs always net to zero balance-sheet impact (`I + J = 0`) — the swap reshapes cash-flow *timing* without changing net Delta. The formula went through two corrections recorded in `decisions.md`: an early three-candidate `MAX` formula double-counted gross legs and produced oversized swaps; the current formula nets spot and forward first. A later fix separated "layers off" (`swap = −spot_raw`, rolling only the untidy spot leg) from "layers on" (adds the cash-floor constraint via `MAX`).

### 3.5 Rate sourcing philosophy

- **Carry / overdraft rates**: sourced from **JPM Notional Pool credit/debit rates** (Jan 2026, LU_661 report), *not* nominal central-bank policy rates — because the LP account earns/pays the JPM rate, not the nominal one (e.g. TRY LP credit is 1.16%, vastly different from its ~46% nominal policy rate).
- **Target end-state**: Covered Interest Rate Parity (CIP) — implied rates derived from live FX forward points (`r_implied = r_USD + (F−S)/S × 365/tenor_days`), sourced from the FX Rate Mesh, replacing the hardcoded table. This is a pending backlog item (see §7).

---

## 4. Application architecture

```
app/
├── page.tsx                 Landing page + Google sign-in
├── layout.tsx
├── workspace/                Workspace shell (Entities → Dashboards → Risk Profiles)
│   └── WorkspaceApp.tsx
├── dashboard/                 The 5-tab FX simulator shell
│   └── Simulator.tsx
└── api/auth/                  NextAuth route handlers

components/
├── UnifiedSimulator.tsx        Main spreadsheet-style FX position table (largest component)
├── BufferOptimizer.tsx         Sensitivity Analysis tab — H* optimizer + charts
├── LayeredBufferAnalysis.tsx   Layer Setup tab — 4-layer buffer composition + portfolio VaR
├── IRProfilePanel.tsx          IR Profile tab — NIM, DV01, fixed/float rate book
├── HedgingDecisionPanel.tsx    Hedging Decision tab — carry-aware hedge suggestions
├── FormulaGrid.tsx / FormulaCell.tsx   Excel-style per-cell formula override + fill-handle
└── LineChart.tsx                Lightweight chart primitive for sensitivity curves

lib/
├── fx-buffer.ts        Core business logic: currency parameters, VaR, buffer, swap, portfolio VaR (~1,600 lines)
├── fx-hedge.ts          Hedge decision engine (spot/forward/option selection)
├── dashboard-model.ts   Unified calculation entry point feeding all tabs from one source of truth
├── formula.ts           Safe expression parser/evaluator for user-entered cell formulas
├── workspace-store.ts   Entity/Dashboard/RiskProfile persistence model (client-side today)
└── *.test.ts            ~2,560 lines of Vitest unit/invariant tests
```

### 4.1 Workspace model — Entities → Dashboards → Risk Profiles

The app is organized as a three-level workspace, designed (per `workspace-store.ts`) to map cleanly onto a future PostgreSQL + Sequelize schema:

- **Entity** — a legal entity / business unit
- **Dashboard** — a named analysis view under an entity, with its own timing/calendar assumptions and formula overrides
- **Risk Profile** — a typed lens on a dashboard. Today only **FX** is implemented; **Bonds/Interest Rates, Equities, Commodities** are modeled as future profile types (currently `available: false`), showing the platform is architected for multi-asset-class risk, not just FX.

Each FX risk profile lets a user opt into specific **FX Inputs** (Liquidity, FX Exposure, Rates, Bonds, Investments, Liabilities) and **Optimization Metrics** (Min Floor, Payout Buffer, Carry Target, Portfolio VaR) — each metric maps directly onto one of the four buffer layers described in §3.3.

### 4.2 The five simulator tabs

1. **FX Simulator** — the primary spreadsheet-style table (`UnifiedSimulator.tsx`) showing, per currency: cash position, TMS FX exposure (spot/forward/non-cash), net FX book, VaR buffer, target LP cash, swap near/far legs, post-swap cash, cycle-end cash, carry P&L, and net Delta. Every cell can carry a **custom user-entered formula** (Excel-style `= cash * 1.1 + nonLpCash` syntax, evaluated by a safe recursive-descent parser with named-field references and a small function library: `abs`, `min`, `max`, `round`, `sqrt`, `pow`, `floor`, `ceil`) with fill-handle drag-to-copy behavior across rows.
2. **Sensitivity Analysis** (`BufferOptimizer.tsx`) — computes the optimal buffer `H*` and renders sensitivity curves against carry differential (Δr), forecast uncertainty (σ_P), and overdraft rate (r_OD), plus a multi-currency EARN/PAY carry comparison table.
3. **Layer Setup** (`LayeredBufferAnalysis.tsx`) — toggle the four buffer layers on/off, see each layer's dollar contribution per currency, set the Portfolio VaR policy limit, and view the diversified cross-currency VaR with per-currency component VaR, standalone VaR and beta.
4. **IR Profile** (`IRProfilePanel.tsx`) — net interest margin (floating + fixed), DV01, and 100bp mark-to-market sensitivity per currency, tying the FX buffer decision to its interest-rate P&L consequence.
5. **Hedging Decision** (`HedgingDecisionPanel.tsx`) — for each currency, recommends **NONE / SPOT / FWD / OPTION** hedge actions based on carry direction, excess long cash above target, and pipeline (forecast) FX needs, with the annualized USD carry benefit of each recommended action.

All five tabs stay mounted simultaneously (CSS-hidden rather than unmounted) and share a single computed model (`computeDashboardModel` in `dashboard-model.ts`), so switching tabs never loses state and every number is internally consistent — there is one source of truth, not five independent calculators.

### 4.3 Currency coverage

The model natively covers **25 currencies** with individually calibrated parameters (`CURRENCY_PARAMS` in `fx-buffer.ts`): AED, AUD, CAD, CHF, CNY, CZK, DKK, EUR, GBP, HKD, HUF, ILS, JPY, MXN, NOK, NZD, PLN, RON, RSD, SEK, SGD, THB, TRY, USD, ZAR. A 14-currency subset feeds the portfolio-diversification VaR (pegged/thin-liquidity currencies like AED, HKD, CNY are excluded from the correlation matrix but still get per-currency buffers).

### 4.4 Consistency invariants

A dedicated Cursor rule (`.cursor/rules/fx-simulator-consistency.mdc`) and a `fx-simulator-invariants.test.ts` suite encode ten "must hold simultaneously" invariants for the simulator — e.g. total swap USD nets to zero across the book, `Target LP Cash = Opening LP + Swap` by construction, the σ layer scales on gross `|payout|` not net deficit, and targets are never liquidated to zero purely to satisfy the VaR limit. This exists precisely because several of the historical bugs recorded in `decisions.md` were column-by-column fixes that broke a different invariant — the rule instructs future changes to be validated against the whole system, not one column.

---

## 5. Governance: policy and strategy encoded in the tool

The platform is explicitly built to reflect (not replace) Treasury's written FX policy and 2026 strategy documents:

### 5.1 From the FX Hedging Policy (`fx-hedging-policy.md`)
- **Approval thresholds** are hard limits the tool must respect: FX position size >$50M/$100M/$250M requires Director of Finance/CFO/CEO approval; stressed P&L VaR >$5M/$10M/$20M requires the same escalation chain. The Portfolio VaR layer's policy-limit control in the Layer Setup tab is a direct implementation of this.
- **Liquidity Pool (LP)** mechanics — cash concentration, credit lines collateralized across currencies, and the rule that a negative FCY balance is only allowed without Director-of-Finance approval when `USD credit rate > FCY debit rate` — underpin the EARN/PAY carry classification throughout the model.
- **Restricted currencies (Model 3)** are tracked in exposure but excluded from trading P&L KPIs — a distinction the division doc reiterates and the codebase respects conceptually (buffers are computed for all currencies; P&L attribution is a separate concern).

### 5.2 From the 2026 FX Hedging & Risk Management Strategy (`fx-hedging-strategy.md`)
- **Automation targets** this platform advances: FX swap netting to decrease P&L fluctuation, LP-liquidity-driven automatic swap sizing, and a multi-instrument decision algorithm (Swap vs. Spot vs. Option) based on current position, LP cash, and market signals — the Hedging Decision panel is a first implementation of that decision layer.
- The EUR/USD decision matrix (market structure × momentum × mood → hedge type/instrument/delta) is documented as the target risk layer to embed once validated with banks; it is not yet wired into the hedge engine, which currently uses a simpler carry-direction rule.

### 5.3 From division/department engineering & compliance standards
- Financial amounts and rates in the model follow the naming and rounding conventions from `div/standards.md` conceptually (amounts to 2dp, rates to 4dp) though the current implementation uses native JS numbers rather than `Decimal.js` — a gap worth flagging against the FX division's own code standard, which mandates `Decimal.js` for all FX calculations and never native floats.
- All financial-data access is meant to go through the Treasury MCP per department standards; today the app uses hardcoded/manually-updated rate tables (JPM LU_661 reports) rather than a live MCP/FX-Rate-Mesh feed — see the "Integrate live CIP-implied rates" backlog item below.

---

## 6. Technology stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 15 (App Router) | Server components by default; `'use client'` only on interactive simulator components |
| Language | TypeScript (strict) | No `any`; explicit interfaces (`RowState`, `SharedGlobals`, `UsdParams`, `LayerResult`…) |
| Auth | NextAuth (Auth.js) v5 + Google OAuth | Session-gated `/workspace`; no client-trusted user IDs |
| UI | React 19 + Tailwind CSS 4 | Dark "workbench" skin (`sim-dark`) when embedded in the workspace shell |
| Testing | Vitest (+ v8 coverage) | ~2,560 lines across dedicated invariant, regression, and unit-test files |
| Persistence (current) | Client-side `localStorage`, scoped per signed-in user | Explicitly documented as a prototype layer designed to map onto Postgres + Sequelize (Entity → Dashboard → RiskProfile tables) |
| Deployment | Docker (multi-stage, Node 24-alpine) → Helm chart → ArgoCD | `fx-test-project` sandbox; ECR image registry; external secrets via AWS Secrets Manager |
| CI | GitHub Actions (`ci.yml`, `pre-deploy-test.yml`, `preview-build.yml`) | |

This stack is a deliberate, scoped deviation from the CLAUDE.md non-negotiable stack (Next.js/PostgreSQL/Sequelize/ioredis) for its **prototype/simulation phase** — no database is provisioned yet (`database.enabled: false` in `values.yaml`), and persistence is intentionally client-side until the workspace model graduates to a backend.

---

## 7. Test Mode — Sigma Tasks sandbox

Parallel to the FX Buffer Simulator workbench (`/workspace`), the app ships a gated **Simple Sigma Test Dashboard** at `/test` for curriculum Sigma Tasks.

| Piece | Detail |
|---|---|
| Entry | Landing CTA **Open Test Dashboard** (when `TEST_MODE_ENABLED=true`) |
| Auth | Guest Credentials provider (`test@sigma.local`) — separate localStorage namespace `treasury:test:*` so it never overwrites a Google user's FX workspace |
| Banner | Persistent **Test Dashboard — sample data** |
| Task 01 | Parent **Group FX** + entity dashboards; FX Risk book only; profile presetup = **Decision** (Hedging, Δ=1 unhedged) + **Analytical** (Risk Metrics VaR / Sensitivity / Monte Carlo); **Validate** (±5%) |
| Engine | `lib/test-mode/` — NordTech seeds, consolidate, `buildHedgeVarSummary`, `scoreTask01` |
| Production gate | Off unless `TEST_MODE_ENABLED=true`; in `NODE_ENV=production` also requires `TEST_MODE_ALLOW_PROD=true` |

Task 01 acceptance targets: open Group FX; EUR Net FX stock **+€1.9M** (4.9 − 3 debt), PLN stock **−zł1.8M**, EUR 1M 99% VaR **≈ $110K** (all ±5%).

---

## 8. Current state and open roadmap

From `.claude/rules/project/context.md`, sprint goals already delivered:

- ✅ Swap restructuring sizing formula validated and documented
- ✅ Dynamic H threshold (VaR + IR carry) implemented, then superseded by the interest-rate-optimization model
- ✅ Aggregated per-currency threshold view with USD equivalents
- ✅ Buffer Optimizer simulation screen (sensitivity charts + multi-currency carry comparison)
- ✅ JPM NP rates replacing nominal central-bank rates in `CURRENCY_PARAMS`
- ✅ Portfolio diversification VaR as a 4th buffer layer (14×14 correlation matrix)
- ✅ Buffer-scale bug fix (`|forecasted_cash|` vs. `|payout|`) and swap-formula fix for layers-off mode

Open items still tracked:

- [ ] **Live CIP-implied rates** from the FX Rate Mesh API client, replacing hardcoded `CURRENCY_PARAMS.carry`
- [ ] **Automated NWC maximization**: for EARN-carry currencies, automatically size buffers to the pre-positioning maximum; for PAY-carry currencies, minimize to reduce opportunity cost
- [ ] **Swap balance-sheet netting confirmation**: verify `I + J = 0` treatment against actual LP accounting

---

## 9. Summary

Simple Sigma is the FX Team's move from static, hand-maintained Excel models to a **live, tested, policy-aware simulation platform**. Its core value is threefold:

1. **Correctness** — every formula in the model (dynamic H, swap sizing, portfolio VaR, carry direction) has a documented derivation, a documented set of alternatives that were rejected and why, and an automated invariant test suite that prevents the recurrence of previously-fixed bugs.
2. **Policy alignment** — VaR and position-size approval thresholds from the FX Hedging Policy flow directly into the Layer Setup tab's Portfolio VaR control, keeping every simulated buffer decision inside Treasury's approved risk envelope.
3. **Decision support, not just reporting** — the Hedging Decision tab converts the buffer/carry state of each currency into an actionable spot/forward/option recommendation, moving the tool from a passive dashboard toward the automated, multi-instrument hedging decision layer that is the FX Team's stated 2026 strategy.
