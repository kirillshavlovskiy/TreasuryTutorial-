# Architecture Decisions

> Maintained by: all team members
> Record decisions when made, not after. Commit alongside the implementing code.
> Ask Claude to help document the decision after it helps you implement it.

## Format

```
## <short title>

**Date:** YYYY-MM-DD
**Decision:** What was decided (one sentence)
**Alternatives considered:** What else was evaluated
**Reason:** Why this choice was made
**Anti-patterns:** What NOT to do as a result — prevents future re-debates
**Ticket:** FX-XXX
```

---

## Active Decisions

## Dynamic minimum cash threshold H — VAR and IR carry proxy (PENDING DECISION)

**Date:** 2026-04-29
**Decision:** Under evaluation — three options below. Currently H is a fixed constant (100,000) applied uniformly across all currencies and scenarios.
**Alternatives considered:** See Options A, B, C below.
**Reason:** Fixed H ignores position size, currency volatility, and carry income risk. For EM currencies a depreciation event simultaneously reduces FX mark-to-market value AND future carry income — both losses need to be buffered.
**Anti-patterns:** Do not apply VAR logic to FCY liquidity sufficiency (whether you have enough FCY to make payments). VAR measures USD P&L impact; FCY payment capacity is a volume question — a depreciation of AUD/USD does not reduce your AUD balance. Keep the two concepts separate.
**Ticket:** —

### Where VAR applies in this model

| Use | VAR relevant? | Reason |
|-----|--------------|--------|
| FCY liquidity / payment capacity (NP Liquidity sheet) | No | AUD balance doesn't change when AUD/USD moves. Liquidity = FCY volume, not USD value |
| USD P&L impact / NWC risk (Loss Fraction VAR sheet) | Yes | Policy approval thresholds ($5M/$10M/$20M) are USD VAR limits |
| Setting minimum cash buffer H (Time structuring H) | Yes | H is a risk buffer — its size should reflect how far the position can move against you |
| NP Target Cash Buffer column I | Partial | Per-currency FCY buffer; should be VAR-derived but currently mixed hardcoded + formula |

### The IR carry linkage

When a currency depreciates, interest rates may also adjust. Effect on combined loss:
```
Total loss = FX mark-to-market loss + carry income loss
           = position × Δs  +  position × carry_rate × β_IR × Δs
           = position × Δs × (1 + carry_rate × β_IR)
```
Where Δs = FX depreciation size (= σ × z for VAR), β_IR = empirical coefficient of IR change per unit FX move.

IR uplift on H by currency type (approximate, requires calibration):

| Currency type | Carry | β_IR | IR uplift on H |
|---|---|---|---|
| DM (EUR, GBP, JPY, AUD, CAD) | 0.5–5% | 0.15–0.30 | +0.1–2% — immaterial |
| Mid-yield (MXN, ZAR) | 8–11% | 0.55–0.60 | +4–6% — moderate |
| High-yield EM (TRY) | ~47% | ~0.80 | +38% — material |

For DM currencies the IR component is negligible. For EM currencies it is significant and should not be ignored.

### Option A — Pure VAR-FCY proxy

```
H = VAR_USD(95%) / spot_rate  =  |FCY_position| × σ × z₉₅
```
Converts the existing Loss Fraction VAR output back to FCY at current rate. H becomes currency-specific and volatility-scaled. Computable once Std Deviation sheet is populated.

**Pro:** Uses existing model infrastructure. Single tuning parameter (confidence level). Automatically scales with position and volatility.
**Con:** No IR component. 1-year VAR horizon is conservative for short-term cash management — may want to scale by √(horizon_days/252).
**Best for:** DM currencies (EUR, GBP, AUD, JPY, CHF, CAD) where IR sensitivity is low.
**Prerequisite:** Std Deviation Model Daily sheet must be populated with σ values.

### Option B — Combined FX + IR carry loss threshold

```
H = |FCY_position| × σ × z₉₅ × (1 + carry_rate × β_IR)
```
Augments Option A with a carry income loss multiplier. β_IR is a per-currency coefficient requiring empirical calibration from historical data (not yet in the model).

**Pro:** Captures full economic loss (FX depreciation + carry income erosion). Most accurate for EM book.
**Con:** β_IR requires calibration; adds per-currency parameters that need maintenance. β_IR is not stable — it varies with the monetary policy regime.
**Best for:** EM currencies (TRY, MXN, ZAR) where carry is large and historically correlated with FX direction.

### Option C — NP buffer parity

```
H = NP_Target_Cash_Buffer[currency]   (column I, NP Liquidity Analysis sheet)
```
References the per-currency FCY buffer already defined in the NP Liquidity sheet rather than the fixed 100K constant.

**Pro:** Single source of truth — H is consistent across the NP and Time Structuring layers. No new methodology needed.
**Con:** NP buffers themselves are inconsistently defined: major currencies (AED, AUD, CAD, CHF, EUR, GBP) are hardcoded manually; others use `E_NP − VAR_ref` formula which depends on the broken Std Deviation layer. Consistency problem is deferred, not solved.
**Best for:** Near-term alignment across sheets while building toward Option A/B.

### Recommended implementation path

1. **Phase 1 (prerequisite):** Populate Std Deviation Model Daily with σ per currency — unblocks the VAR chain and the formula-based NP buffers automatically
2. **Phase 2:** Replace fixed H = 100,000 with Option A formula for all currencies — `VAR_FCY(95%)` scaled to the cash management horizon (e.g., 1-month: `σ × z₉₅ × √(21/252)`)
3. **Phase 3:** Apply Option B multiplier `(1 + carry_rate × β_IR)` for EM currencies (TRY, MXN, ZAR, RSD) once β_IR coefficients are calibrated from the log-return history already in the model

---

## Dynamic H threshold — Option A+B selected: VAR-FCY with IR carry multiplier

**Date:** 2026-04-29
**Decision:** Implement combined Option A+B. H (minimum cash threshold) becomes a dynamic formula per currency based on 1-month VAR scaled by a carry-IR multiplier. Architecture: all parameters live in Std Deviation Model Daily; NP Liquidity column I and Time Structuring H both reference that sheet.
**Alternatives considered:** Option C (NP buffer parity) — deferred. Options A and B as standalone — both subsumed into the combined formula.
**Reason:** Fixed H = 100K is order-of-magnitude wrong for large positions (e.g. AUD 21M → dynamic H is 1.3M, 13× larger). IR carry component is material only for EM currencies (TRY: +37% uplift) but negligible for DM (<2%), making A+B the correct unified approach.
**Anti-patterns:** Do not use 1-year VAR horizon for the cash threshold — the forecast window in Time Structuring is 1 month (column G). Scale σ to the 1-month horizon with √(21/252). Do not use carry alone as the threshold driver — FX volatility is the primary component, carry is an additive multiplier only.
**Ticket:** —

### Combined formula

```
H = MAX(H_min,  |C + D|  ×  σ_daily × √21 × z₉₅  ×  (1 + carry_rate × β_IR))
```

Where:
- `C + D` = net FX position (spot + forward) from Time Structuring columns C and D
- `σ_daily` = daily log-return standard deviation, computed from Lognormal return distribution sheet
- `√21` = 1-month time scaling (21 trading days)
- `z₉₅` = 1.645 (95% confidence)
- `carry_rate` = current overnight/policy rate for the currency (decimal)
- `β_IR` = empirical IR sensitivity coefficient per currency (see table below)
- `H_min` = operational floor (suggested: 50,000 FCY or as set by NP ops team)

Expanding: `σ_daily × √21 × z₉₅` is the 1-month VAR factor, which is `σ_annual × z₉₅ × √(21/252)`.

### Implementation architecture

Single data chain — no circular references:

```
Lognormal return distribution sheet
    → STDEV(daily log returns) per currency
    → Std Deviation Model Daily  [add: σ_daily, carry_rate, β_IR, combined_multiplier]
        → NP Liquidity column I (Target Cash Buffer, FCY)
            → Time Structuring column H (Target Cash)
```

**Changes to Std Deviation Model Daily — add columns:**

| New column | Label | Formula / Value |
|---|---|---|
| J | carry_rate | Hardcoded per currency (see table) |
| K | β_IR | Hardcoded per currency (see table) |
| L | VAR95_1M_factor | `= σ_daily × SQRT(21) × 1.645` |
| M | combined_multiplier | `= (1 + J × K)` |

**New formula for NP Liquidity column I (Target Cash Buffer, FCY):**
```
= MAX(50000, ABS(B) × VLOOKUP(A, 'Std Deviation Model Daily'!A:M, 12) × VLOOKUP(A, 'Std Deviation Model Daily'!A:M, 13))
```
i.e. `MAX(H_min, |position_FCY| × VAR95_1M_factor × combined_multiplier)`

**New formula for Time Structuring column H (Target Cash):**
```
= VLOOKUP(currency_ref, 'NP Liquidity Analysis'!A:I, 9)
```
References the NP buffer directly — single source of truth. Requires adding a currency reference cell to the Time Structuring sheet (currently absent).

### Full parameter table (25 model currencies)

Computed from historical log-return data (2019–2026, n=1,300–2,200 observations per currency).

| CCY | σ_daily | σ_annual | VAR95_1Y | VAR95_1M_factor | carry% | β_IR | multiplier | H_combo_1M% of position |
|-----|---------|----------|----------|----------------|--------|------|------------|------------------------|
| AED | 0.000045 | 0.0007 | 0.12% | 0.03% | 5.15 | 0.00 | 1.0000 | 0.03% |
| AUD | 0.008227 | 0.1306 | 21.48% | 6.20% | 4.35 | 0.25 | 1.0109 | 6.27% |
| CAD | 0.004256 | 0.0676 | 11.11% | 3.21% | 2.75 | 0.25 | 1.0069 | 3.23% |
| CHF | 0.004312 | 0.0685 | 11.26% | 3.25% | 0.50 | 0.15 | 1.0008 | 3.25% |
| CNY | 0.002541 | 0.0403 | 6.64% | 1.92% | 3.10 | 0.10 | 1.0031 | 1.92% |
| CZK | 0.005609 | 0.0890 | 14.65% | 4.23% | 3.75 | 0.40 | 1.0150 | 4.29% |
| DKK | 0.004193 | 0.0666 | 10.95% | 3.16% | 2.60 | 0.15 | 1.0039 | 3.17% |
| EUR | 0.004372 | 0.0694 | 11.42% | 3.30% | 2.65 | 0.20 | 1.0053 | 3.31% |
| GBP | 0.004966 | 0.0788 | 12.97% | 3.74% | 4.50 | 0.25 | 1.0112 | 3.79% |
| HKD | 0.000465 | 0.0074 | 1.21% | 0.35% | 4.75 | 0.00 | 1.0000 | 0.35% |
| HUF | 0.007234 | 0.1148 | 18.89% | 5.45% | 6.50 | 0.55 | 1.0357 | 5.65% |
| ILS | 0.005285 | 0.0839 | 13.80% | 3.98% | 4.50 | 0.35 | 1.0157 | 4.05% |
| JPY | 0.005082 | 0.0807 | 13.27% | 3.83% | 0.50 | 0.15 | 1.0008 | 3.83% |
| MXN | 0.007892 | 0.1253 | 20.61% | 5.95% | 9.00 | 0.60 | 1.0540 | 6.27% |
| NOK | 0.007846 | 0.1246 | 20.49% | 5.91% | 4.50 | 0.30 | 1.0135 | 5.99% |
| NZD | 0.006398 | 0.1016 | 16.71% | 4.82% | 3.75 | 0.25 | 1.0094 | 4.87% |
| PLN | 0.006363 | 0.1010 | 16.62% | 4.80% | 5.75 | 0.50 | 1.0288 | 4.93% |
| RON | 0.004522 | 0.0718 | 11.81% | 3.41% | 6.50 | 0.45 | 1.0292 | 3.51% |
| RSD | 0.004171 | 0.0662 | 10.89% | 3.14% | 5.75 | 0.45 | 1.0259 | 3.23% |
| SEK | 0.006511 | 0.1034 | 17.00% | 4.91% | 2.25 | 0.25 | 1.0056 | 4.94% |
| SGD | 0.002694 | 0.0428 | 7.04% | 2.03% | 3.50 | 0.15 | 1.0052 | 2.04% |
| THB | 0.004254 | 0.0675 | 11.11% | 3.21% | 2.00 | 0.25 | 1.0050 | 3.22% |
| TRY | 0.009301 | 0.1476 | 24.29% | 7.01% | 46.00 | 0.80 | 1.3680 | 9.59% |
| USD | 0.000000 | 0.0000 | 0.00% | 0.00% | 4.33 | 0.00 | 1.0000 | 0.00% |
| ZAR | 0.008518 | 0.1352 | 22.24% | 6.42% | 7.50 | 0.60 | 1.0450 | 6.71% |

σ values computed from Lognormal return distribution sheet (historical daily log returns, USD base).
β_IR values are approximate empirical coefficients — require recalibration when monetary policy regime changes materially (especially TRY).

### Impact vs fixed H = 100,000

Fixed H = 100K FCY is applied uniformly regardless of position size or currency. With dynamic H:
- AUD position 21M → H_dynamic ≈ 1.32M (13× larger than fixed)
- TRY position 65M → H_dynamic ≈ 6.23M (62× larger than fixed)
- CNY position 28M → H_dynamic ≈ 538K (5× larger than fixed)
- HKD/AED (pegged) → H_dynamic ≈ H_min, effectively unchanged

## Swap restructuring sizing formula — Time structuring sheet

**Date:** 2026-04-29
**Decision:** Swap near-leg size (column I) is `MAX(H − (F + G), −(C + D))` — the larger of the cash maintenance gap and the net position restructuring need.
**Alternatives considered:** Original formula `MAX(MIN(−D,−C), H−(F+G), MAX(−C,D))` — three-candidate MAX using gross individual legs
**Reason:** See full strategy logic below.
**Anti-patterns:** Do not size the swap to the gross dominant leg `MAX(−C, D)` — this ignores netting of spot and forward positions and produces oversized swaps when both legs are partially offsetting. Do not buy FCY near when net position is already long and cash is above threshold.
**Ticket:** —

### Strategy: FX Swap Restructuring Layer

An FX swap restructuring swap moves the timing of an FX position without changing the net exposure. The near leg (column I) executes today; the far leg (column J = −I) executes at a future tenor. Because I + J = 0, the swap contributes zero to net Delta — it only reshapes the cash flow time profile.

**Inputs:**

| Column | Label | Meaning |
|--------|-------|---------|
| C | FX without outright exposure | Net spot FX position (negative = short FCY) |
| D | FX FWD | Forward FX position (positive = long FCY fwd) |
| E | Non Cash BS FX | Non-cash balance sheet FX (accruals, non-deliverables) |
| F | Cash | Current FCY cash balance |
| G | Payout Forecasted Cash 1M | Expected net cash movement over the 1-month forecast horizon |
| H | Target Cash | Minimum cash threshold to maintain (set at 100,000) |
| I | Swap near leg | FCY bought (positive) or sold (negative) in the near tenor |
| J | Swap far leg | Always = −I; the offsetting leg at the far tenor |

**Two constraints that govern swap size:**

**Constraint 1 — Minimum cash state maintenance:**
After the near leg settles, FCY cash must be at or above threshold H.
```
Required swap ≥ H − (F + G)
```
- If F + G ≥ H (cash already above threshold): this constraint is negative — no forced buy
- If F + G < H (cash below threshold): this constraint is positive — must buy FCY to top up

**Constraint 2 — Net position restructuring:**
The swap should be sized to neutralize the net FX position (spot + forward combined), moving it entirely to the far tenor.
```
Required swap ≥ −(C + D)
```
- If C + D < 0 (net short FCY): `−(C+D)` is positive — buy near to cover the short
- If C + D > 0 (net long FCY): `−(C+D)` is negative — sell near to deploy the long

**Combined formula — take the binding constraint:**
```
I = MAX(H − (F + G),  −(C + D))
J = −I
```

Taking MAX satisfies both constraints simultaneously: the swap is large enough to both fund cash to threshold AND restructure the net position.

**Why the original Candidate 3 `MAX(−C, D)` was wrong:**

The original formula used `MAX(−C, D)` as a third candidate — the larger of the two gross legs individually. This ignores netting:

| Scenario | C | D | Net C+D | MAX(−C,D) | −(C+D) | Oversize |
|----------|---|---|---------|-----------|--------|---------|
| Row 4 | −800K | +200K | −600K | 800K | 600K | +200K |
| Row 6 | −400K | +200K | −200K | 400K | 200K | +200K |
| Row 10 | −200K | +400K | +200K | 400K | −200K | +600K |

In Row 10 the error is most severe: net position is already long (+200K) and cash is above threshold, yet the original formula forces a +400K buy. The fixed formula correctly recognises the net-long state and either sells near or does nothing beyond cash maintenance.

**Why Candidate 1 `MIN(−D, −C)` was removed:**

`MIN(−D, −C)` (the smaller of the two gross legs) never won against the other candidates across any scenario and is mathematically subsumed by `−(C+D)` — the net is always between the two gross extremes. It added complexity without contributing to any scenario outcome.

**Interest / carry cost (column L):**
```
L = −(C + D) × K%
```
K = 0.4% (carry rate). Sign convention: net short position (C+D < 0) generates positive carry income; net long generates carry cost. This is correct and unchanged.

**Delta identity:**
```
O = C + D + I + J + L + E  =  C + D + 0 + L + E
```
Since I + J = 0, the swap leaves net Delta unchanged. Delta is driven entirely by the net spot/forward position, carry, and non-cash BS FX.

## Threshold distribution — aggregated view, USD balance, and implied rate allocation

**Date:** 2026-04-29
**Decision:** The model must (a) track total H threshold per currency summed across all scenario rows, (b) carry a USD-equivalent column alongside every FCY threshold, and (c) use market-implied interest rates derived from FX forward points (CIP) as the `carry_rate` input instead of nominal central bank policy rates. Buffer distribution across currencies is governed implicitly by implied rates: higher implied rate → larger combined_multiplier → larger H → larger USD commitment.
**Alternatives considered:** Nominal policy rates as carry (original A+B baseline). Per-row H with no aggregation (current state). Explicit redistribution step separate from the VAR formula.
**Reason:** (1) Aggregation gives the total capital committed per currency across all forecast scenarios — needed for NP collateral planning. (2) USD equivalents make inter-currency comparison possible and allow monitoring against the total NP USD balance. (3) Implied rates from the forward market are forward-looking and already embed market expectations, credit premia, and liquidity costs — they are directly observable from FX forward quotes and do not require a separate IR model. Nominal policy rates lag the market and systematically understate carry for currencies in rate-transition regimes.
**Anti-patterns:** Do not use central bank policy rates as a proxy for implied rates — they lag the market and understate carry (especially for TRY during normalization phases). Do not build a separate explicit redistribution step — the combined_multiplier `(1 + implied_rate × β_IR)` already IS the distribution mechanism; re-weighting on top creates double-counting. Do not allocate equal buffer to all currencies regardless of implied carry.
**Ticket:** —

### Implied rate derivation — Covered Interest Rate Parity (CIP)

The implied foreign interest rate for any currency is observable directly from FX spot and forward prices:

```
r_implied_ccy = r_USD  +  (F_rate − S_rate) / S_rate  ×  (365 / tenor_days)
```

Where:
- `S_rate` = FX spot rate (USD per 1 unit of FCY, e.g. AUDUSD = 0.647)
- `F_rate` = FX forward rate for the 1-month tenor
- `r_USD` = USD overnight rate (e.g. SOFR / Fed Funds: ~4.33% — single input cell)
- `tenor_days` = 30 for 1-month forward

Sign: when `F_rate < S_rate` the FCY trades at a forward discount → implied FCY rate > USD rate → positive carry for long FCY. When `F_rate > S_rate` the FCY trades at a forward premium → implied FCY rate < USD rate → negative carry cost for long FCY.

**Why implied over nominal:**
Forward points already incorporate the full market view — rate expectations, sovereign risk, liquidity cost. Using `(F−S)/S` avoids any need to look up or maintain central bank policy rates. The spot and forward rates are already available in the TMS and FX Rate Mesh.

**New column in Std Deviation Model Daily (add after column M):**

| Col | Label | Formula |
|-----|-------|---------|
| N | implied_rate_1M | `= $r_USD + (fwd_rate_col − spot_rate_col) / spot_rate_col × (365/30)` |

`fwd_rate_col` and `spot_rate_col` are per-currency input columns populated from TMS/FX Rate Mesh daily. `$r_USD` is a single fixed cell (update daily).

**Update combined_multiplier formula (column M) to use implied rate:**
```
M = (1 + N × K)    — where N = implied_rate_1M, K = β_IR
```
Revised H formula:
```
H = MAX(H_min,  |C + D|  ×  σ_daily × √21 × z₉₅  ×  (1 + implied_rate_1M × β_IR))
```
All other formula components unchanged.

### Aggregated threshold per currency

The model computes H per scenario row (Time Structuring). A separate aggregation is required to see total buffer committed per currency across all rows:

```
H_total_FCY[ccy] = SUMIF(currency_column, ccy, H_column)   [Time Structuring sheet]
H_total_USD[ccy] = H_total_FCY[ccy] × spot_rate[ccy]
```

This produces a summary by currency showing: how much FCY buffer is committed across all scenarios, and what that costs in USD terms (NP collateral consumed).

**New summary table — add to NP Liquidity Analysis sheet (below main table):**

| Column | Label | Formula |
|--------|-------|---------|
| A | Currency | (same as main table rows) |
| B | H_total_FCY | `= SUMIF('Time Structuring'!currency_col, A, 'Time Structuring'!H_col)` |
| C | spot_rate | (live feed from FX Rate Mesh / TMS) |
| D | H_total_USD | `= B × C` — USD cost of committing this buffer |
| E | % of NP USD balance | `= D / SUM(D:D)` — each currency's share of total buffer commitment |
| F | implied_rate_1M | `= VLOOKUP(A, 'Std Deviation Model Daily'!A:N, 14)` |
| G | rank | `= RANK(F, F_range)` — currencies ranked by implied rate (distribution driver) |

### USD Balance column alongside FCY threshold

In the NP Liquidity Analysis sheet, add a USD column immediately after column I (Target Cash Buffer FCY):

| New col | Label | Formula |
|---------|-------|---------|
| I | Target Cash Buffer (FCY) | existing: `MAX(H_min, ABS(B) × VAR95_1M_factor × combined_multiplier)` |
| J | Target Cash Buffer (USD) | `= I / spot_rate` — USD cost of holding this buffer |
| K | % of NP USD total | `= J / SUM(J:J)` — share of total NP USD balance reserved as buffer |

Note: `I / spot_rate` assumes S_rate is in FCY-per-USD convention. If the sheet uses USD-per-FCY (AUDUSD convention), use `= I × spot_rate` instead. Verify against existing column B (NP Position FCY) convention before implementing.

### How implied rates drive the distribution

The distribution mechanism is embedded in the combined_multiplier — no separate reallocation step is needed:

```
high implied_rate_1M  →  large combined_multiplier  →  large H  →  large H_USD
low  implied_rate_1M  →  multiplier ≈ 1.0            →  H ≈ pure VAR component
```

Pegged currencies (AED β_IR=0, HKD β_IR=0) always get multiplier = 1.0 regardless of nominal implied rate — their forward points reflect USD peg, not independent carry risk.

**Distribution summary statistics to add to the model:**

```
Total H_USD committed = SUMPRODUCT(H_FCY_range, spot_rate_range)
% of NP USD balance   = Total H_USD / NP_total_USD_balance
Weighted avg implied  = SUMPRODUCT(H_USD_range, implied_rate_range) / Total H_USD
```

These three metrics let the FX team answer: "How much of the NP balance is locked in buffers, and what is the average implied carry we are paying to hold it?"

## H redefined — interest-rate optimization, not FX risk proxy

**Date:** 2026-04-29
**Decision:** H (minimum cash threshold) is an interest-rate optimization problem. The EOM forward structure already guarantees FCY delivery — FCY payment capacity is not at risk. H should be sized to minimize the combined cost of holding FCY (opportunity cost vs USD deposit rate) plus the expected cost of overdraft, not to buffer FX mark-to-market losses.
**Alternatives considered:** VAR-based H (Options A+B) — retained as the NWC P&L risk measure, but decoupled from the liquidity threshold. Using fixed H = constant — rejected because it ignores position size, rate differentials, and forecast uncertainty simultaneously.
**Reason:** When EUR depreciates, the EUR balance is unchanged — only the USD equivalent falls. For a €100M position with a €25M buffer, the EUR/USD rate is second-order noise. The buffer is in EUR, serves an EUR purpose. VAR belongs in the Loss Fraction sheet (USD P&L limits per policy), not in the liquidity threshold column.
**Anti-patterns:** Do not use FX volatility (σ) as a driver for the liquidity buffer H — VAR measures USD P&L risk, not whether you can make EUR payments. Do not confuse FCY liquidity sufficiency (payment capacity = FCY volume) with NWC risk (USD P&L impact of depreciation). Keep the two measures in separate columns/sheets.
**Ticket:** —

### Optimal buffer formula

```
H* = MAX(H_min,  P × (1 + σ_P × Φ⁻¹(1 − Δr / r_OD)))
```

Where:
- `P` = expected FCY payouts before forward settles
- `σ_P` = forecast uncertainty (std dev of payout volume as fraction of P)
- `Δr` = r_USD − r_FCY (carry differential; positive when USD earns more)
- `r_OD` = overdraft facility rate for this currency
- `Φ⁻¹` = inverse normal CDF

**Interpretation:**
- `Δr / r_OD` = optimal probability of accepting an overdraft
- When `Δr ≤ 0` (FCY earns ≥ USD): hold maximum buffer — profitable to pre-position
- When `Δr = r_OD`: hold exactly P — indifferent above/below
- When `Δr > r_OD` (impossible in practice): hold below P

**Cost functions (per period):**
```
C_hold = MAX(0, Δr/100) × H × days/365       — opportunity cost of holding FCY
C_OD   = σ_P × P × φ(z_H) × r_OD/100 × days/365  — expected overdraft cost
TC     = C_hold + C_OD                         — total cost minimised at H*
```
Where `z_H = (H − P) / (σ_P × P)` and `φ` is the standard normal PDF.

### What drives the buffer (sensitivity ranking)

1. **Forecast quality (σ_P)** — biggest lever. Improving payout forecast accuracy reduces buffer more than any rate change.
2. **Overdraft facility rate (r_OD)** — negotiate this with the bank before tuning any formula.
3. **Carry differential (Δr)** — 4% swing in Δr moves H* by ~7% of P.
4. **Settlement gap (days)** — shorter gap between payout due and forward settlement shrinks exposure window.

### NWC interest optimization

For currencies where `r_FCY > r_USD` (GBP 4.50%, AUD 4.35%, MXN 9.00%, TRY 46.0%):
- `Δr < 0` → optimal shortfall probability clamps to near 0 → hold maximum buffer
- Holding more FCY is actively **profitable** — the carry income offsets the working capital cost
- Maximising NWC in these currencies generates direct P&L benefit

For currencies where `r_FCY < r_USD` (EUR 2.65%, JPY 0.50%, CHF 0.50%):
- `Δr > 0` → optimal to hold less FCY and accept occasional small overdraft
- Each day of excess FCY holding costs `Δr/365 × H` in foregone USD interest

The multi-currency comparison table in the Buffer Optimizer screen shows which currencies are "EARN CARRY" vs "PAY CARRY" — this is the NWC interest allocation dashboard.

---

## Swap position netting in the balance sheet

**Date:** 2026-04-29
**Decision:** FX swap near and far legs always net to zero balance sheet impact: I + J = 0. The restructuring swap reshapes the timing of the FCY position without changing net Delta. Only C + D + L + E flows through to Delta (column O). The swap contributes zero to net FX exposure.
**Alternatives considered:** Gross accounting of each leg separately — rejected, creates false gross exposure in the NP position calculation.
**Reason:** An FX swap is a paired instrument (buy near, sell far = same amount). Accounting it gross would double-count the exposure and misstate NP utilisation. The swap affects only: (a) the timing of cash flows, (b) the interest rate differential captured in the swap bid/ask spread, (c) the NP overdraft profile.
**Anti-patterns:** Do not include the swap near leg (I) in the Delta calculation without also including J = −I. Do not treat a restructuring swap as a net new position — its purpose is solely to shift the existing position in time. Do not size the swap to the gross dominant leg MAX(−C, D) — this ignores netting and produces oversized swaps.
**Ticket:** —

---

## Buffer Optimizer simulation screen

**Date:** 2026-04-29
**Decision:** Build a Next.js TypeScript simulation screen with two tabs: (1) Swap Overlay — an interactive time structuring table replicating the Excel model with live computed columns; (2) Buffer Optimizer — parameter controls, optimal H* calculation, sensitivity charts (carry differential / forecast uncertainty / overdraft rate), and a multi-currency NWC comparison table.
**Alternatives considered:** Excel-only model — kept as source of truth for the actual trading system. Simulator complements it for scenario analysis and decision support.
**Reason:** The buffer formula H* = P × (1 + σ_P × Φ⁻¹(1 − Δr/r_OD)) has five independent parameters. A static table cannot show the interaction surface. The simulation screen makes the carry trade-off immediately visible: drag the r_FCY slider past r_USD and watch H* jump — because holding more FCY is now profitable.
**Anti-patterns:** Do not use VAR (σ_daily, β_IR) in the Buffer Optimizer — that belongs in the Swap Overlay H column as the NWC P&L buffer, not in the payment-capacity buffer calculation. Do not use central bank policy rates in the optimizer — use per-currency deposit/overdraft rates from the banking agreements.
**Ticket:** —

## CURRENCY_PARAMS carry rates — JPM NP rates, not central bank policy rates

**Date:** 2026-04-30
**Decision:** Use JPM Notional Pool credit/debit rates (Jan 2026, LU_661 report) as `carry` and `r_OD` in `CURRENCY_PARAMS`, not nominal central bank policy rates.
**Alternatives considered:** Central bank policy rates (original baseline) — rejected. CIP-implied rates from FX Rate Mesh — the right long-term target, still pending live integration.
**Reason:** The NP account earns and pays the JPM NP rate, not the central bank rate. TRY NP credit = 1.16% vs nominal ~46% — using the nominal rate makes TRY look like a massive EARN currency when it is in fact near-zero carry in the NP. With JPM NP rates and r_USD = 3.50%, only GBP (3.57%), HUF (5.69%), MXN (6.19%), ZAR (6.01%) earn carry. CHF NP debit = 0.15% — extremely low r_OD means the carry optimizer pushes buffer to the floor quickly.
**Anti-patterns:** Never use central bank policy rates (e.g. TRY 46%, RUB etc.) for NP carry calculations — they are not what the NP account earns. Do not hardcode r_USD in CURRENCY_PARAMS — it is a global slider so the carry calculation stays live.
**Ticket:** —

## Portfolio diversification VAR — 4th layer in Buffer Optimizer

**Date:** 2026-04-30
**Decision:** Add a 4th layer "Portfolio VAR" to LayeredBufferAnalysis that computes cross-currency diversified VAR across all FCY buffer holdings using a 14×14 pairwise correlation matrix.
**Alternatives considered:** Per-currency standalone VAR only — rejected because it overstates total risk by ignoring correlation. Full DCC-GARCH dynamic correlations — too complex for a simulation tool; static historical correlations are sufficient for buffer sizing.
**Reason:** Buffer holdings across 14 currencies are correlated. European FX block (EUR/SEK/NOK/PLN/HUF, ρ = 0.70–0.83) moves together — standalone VAR is misleading. JPY has negative correlation with EM currencies, providing genuine diversification. Policy limits ($5M/$10M/$20M from fx-hedging-policy.md) should be checked against portfolio VAR, not the standalone sum.
**Anti-patterns:** Do not check policy approval thresholds against sum of standalone VARs — that ignores diversification and inflates the number. Do not treat the correlation matrix as static forever — recalibrate when monetary policy regime changes (especially for EM currencies in rate-transition phases). Currencies not in CORR_CURRENCIES (AED, CAD, CNY, CZK, DKK, HKD, ILS, NZD, RON, RSD, SGD, THB) are excluded from portfolio VAR — they are included in per-currency buffer calculation but not in the portfolio panel.
**Ticket:** —

## computeLayeredBuffer scale — |forecasted_cash|, not |payout|

**Date:** 2026-05-28
**Decision:** The scale variable in `computeLayeredBuffer` (used for `delta_sigma` and `delta_carry`) is `|forecasted_cash| = |cash + payout|`, not `|payout|`. Fall back to `|payout|` only when `|forecasted_cash| < 0.001`.
**Alternatives considered:** `|payout|` as scale (original implementation) — rejected. Fixed scale — rejected.
**Reason:** `delta_sigma = scale × σ_P × z₉₅` and `delta_carry = scale × σ_P × (z_opt − z₉₅)` measure a fraction of the actual FCY position held in NP, not just the outflow volume. Using `|payout|` produces wildly undersized buffers for large positions. Example: JPY cash=−1539M, payout=−200M → `|forecasted_cash|` = 1739M vs `|payout|` = 200M — an 8.7× difference. The `optimizePortfolioCarry` function already used `|forecasted_cash|` as scale; `computeLayeredBuffer` now matches it for consistency across both computation paths.
**Anti-patterns:** Do not use `|payout|` as the buffer scale — payout is only the monthly outflow, not the position being protected. Do not confuse payout (flow) with forecasted cash (stock position) — the buffer is sized against the stock. The floor (`H_min`) is a constant per-currency value and is unaffected by the scale change.
**Ticket:** —

### Implementation

`lib/fx-buffer.ts` — `computeLayeredBuffer` signature:
```typescript
export function computeLayeredBuffer(
  P: number,               // |payout| — fallback scale when forecasted_cash ≈ 0
  forecasted_cash: number, // cash + payout — actual FCY position (primary scale)
  σ_P: number,
  ...
) {
  const scale = Math.abs(forecasted_cash) > 0.001 ? Math.abs(forecasted_cash) : P;
  const delta_sigma = active.has('sigmaP') ? scale * σ_P * Z_NEUTRAL : 0;
  // ...
  delta_carry = scale * σ_P * (z_opt - Z_NEUTRAL);
}
```

Call sites: `components/LayeredBufferAnalysis.tsx` Pass 1 and `components/UnifiedSimulator.tsx` both compute `forecasted_cash = cash + payout` before the call and pass it as the second argument.

---

## Swap formula — both modes use spot-only restructuring, layers-on adds cash threshold

**Date:** 2026-05-28
**Decision:** Both modes use the same base: reverse the spot position only (`−spot_raw`). The forward is already at the far tenor and needs no near leg. Layers-on adds the cash maintenance constraint via MAX.
- **Layers OFF** → `swap = −spot_raw`
- **Layers ON**  → `swap = MAX(H_final − forecasted_cash, −spot_raw)`
**Alternatives considered:** `swap = MAX(H_final − fcast, −(spot+fwd))` — rejected: including fwd in the restructuring term produces incorrect sells when spot is short but net (spot+fwd) is long (EUR example: spot=−15, fwd=+18, net=+3 → old formula sold 3M EUR instead of buying 15M to close the spot short). `MAX(H_final − fcast, MAX(0, −(spot+fwd)))` — also rejected: gives 0 for EUR when it should give +15 (consistent with no-layers behavior).
**Reason:** The forward is already booked at the far tenor — only the spot is "untidy" at the near tenor. The swap's job is to roll the spot position to the far tenor (near leg = −spot_raw, far leg = +spot_raw). Layers add a cash floor: if cash is below H_final, the buy must be at least `H_final − forecasted_cash`. Taking MAX satisfies both: the spot restructuring and the cash maintenance.
**Anti-patterns:** Do not include `fwd_raw` in the restructuring term — the forward does not need a near leg. Do not use `−(spot+fwd)` for layers-on — it incorrectly includes the forward in the near-leg sizing and produces sells when net is long but spot is short. Do not clamp restructuring to 0 for long spots — rolling a long spot to forward (selling near) is correct FX swap behavior.
**Ticket:** —

### Implementation

`components/LayeredBufferAnalysis.tsx` Pass 3:
```typescript
// Layers OFF: reverse the spot position only; fwd stays on books at far tenor
// Layers ON:  same base + bring cash to threshold if below H_final
const swap_needed = formulaLayersActive
  ? Math.max(H_final - r.forecasted_cash, -r.spot_raw)
  : -r.spot_raw;
```

### Verification table

| Scenario | spot | fwd | fcast | H_final | swap (correct) | Old formula result |
|---|---|---|---|---|---|---|
| EUR floor-only | −15 | +18 | +275.9 | 0 | +15 (close spot short) | −3 (WRONG SELL) |
| JPY cash deficit | −800 | +900 | −1739 | 0 | +1739 (cash maint wins) | +100 (too small) |
| Short spot, cash OK | −100 | 0 | +300 | 50 | +100 (close spot short) | +100 ✓ |
| Long spot, cash OK | +15 | 0 | +300 | 0 | −15 (deploy long to fwd) | −15 ✓ |
| Long spot, cash low | +15 | 0 | −100 | 50 | +150 (cash maint wins) | +150 ✓ |

<!-- Add new decisions above this line -->
