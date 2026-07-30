# FX Division — Team Overview

## Mission

Manage FX exposure across 150+ currencies, implement hedging strategies, and build tooling to automate FX risk management.

## Team structure

- **FX Lead**: Dor
- **FX Engineer**: Kirill Shavlovskiy

## Responsibilities

- FX exposure calculation and VAR modelling
- Hedging execution via TMS (Treasury Management System)
- FX P&L reporting and reconciliation
- FX rate monitoring and alert systems

## Shared services we own

- Treasury MCP — fx_order_search, fx_pl_report, fx_hedging_controls
- FX hedging models (Notional Pool FX Risk Hedging)

## Escalation path

- TMS issues: Neeraj
- Rate feed issues: #treasury-fx Slack

---

## FX Position Rules

**All FX positions are measured and counted against USD** (consolidated reporting currency of the organization).

All currency balances across the group subsidiary structure are included in the open currency position calculation.

### Collection and Hedging Models

The FX team operates three distinct models depending on currency and jurisdiction:

**Model 1 — Global collection + Notional Pool sweep**
- Funds collected globally into the parent entity, swept to Notional Pool account
- FX hedging operates **independently** of the funding and sweep process
- Hedging executed across all NP-supported currencies
- This is the primary model; FX P&L is measured and tracked as trading activity

**Model 2 — Local collection + on-demand conversion**
- Funds collected locally in country
- Converted into salary payout currency as needed
- Used where global sweep is not practical or available

**Model 3 — Restricted currencies (funding-linked FX)**
- Applies where FX conversion **cannot be separated** from the funding process
- Currencies that cannot be borrowed or held offshore (restricted currencies)
- Even when FX is executed, it is **NOT treated as trading activity** and is **NOT measured by P&L KPI**
- These positions ARE still included in the open currency position calculation for each currency
- Kept and managed separately from Models 1 and 2

### Position Calculation Scope

When calculating open currency position:
- Include all 3 models above
- Net assets vs liabilities across all subsidiaries in each currency
- Report in USD equivalent
- Restricted currency positions (Model 3) are included in exposure but excluded from trading P&L

---

## Key Reference Documents

- `fx-hedging-policy.md` — Business policy: definitions, limits, approval thresholds, NWC rules
- `fx-hedging-strategy.md` — 2026 trading strategy, automation targets, decision matrix
