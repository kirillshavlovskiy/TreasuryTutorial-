# Project Context

> Maintained by: all team members
> Update at sprint start and when blockers/stakeholders change.
> Commit alongside the related code change.

## Project

**Name:** test-treasury-project
**Purpose:** FX Exposure VAR Model — models swap hedging layer, time structuring of FX cash positions, and minimum cash state maintenance across currency scenarios. Used by FX Team to size restructuring swaps and validate hedging strategy across forecast horizons.
**Department:** treasury
**Division:** FX Team

## Current Sprint Goals

- [x] Define and validate swap restructuring sizing formula for Time structuring sheet
- [x] Document swap hedging layer logic and cash threshold maintenance model
- [x] Implement dynamic H threshold (Option A+B): σ, β_IR, combined_multiplier — implemented in CURRENCY_PARAMS + calcDynamicH; live in SwapOverlay
- [x] Add aggregated threshold view per currency with USD equivalent — multi-currency table in Buffer Optimizer tab
- [x] Build Buffer Optimizer simulation screen (Next.js): swap overlay table + interest-rate optimal H* + sensitivity charts + multi-currency NWC carry comparison
- [x] Replace hardcoded nominal policy rates in CURRENCY_PARAMS with JPM Notional Pool credit/debit rates (Jan 2026, LU_661 report) — changes EARN/PAY carry classification significantly (TRY NP = 1.16% vs nominal 46%; only GBP/HUF/MXN/ZAR earn carry vs USD NP 3.50%)
- [x] Add portfolio diversification VAR as 4th layer in Buffer Optimizer — 14-currency pairwise correlation matrix, component VAR, standalone VAR, beta, policy limit panel ($5M/$10M/$20M thresholds)
- [x] Fix computeLayeredBuffer scale: changed from |payout| to |forecasted_cash| = |cash+payout| so safety/carry deltas are sized to the actual NP position, not just the outflow volume
- [x] Fix swap formula for layers-off mode: `swap = −spot_raw` only (reverse spot position; fwd already at far tenor); layers-on stays `MAX(H_final − fcast, −(spot+fwd))`
- [ ] Integrate live CIP-implied rates from FX Rate Mesh API: replace hardcoded CURRENCY_PARAMS.carry with r_USD + (F−S)/S × 365/30 per currency, sourced from `@letsdeel/fx-rate-mesh-node-client`
- [ ] Maximize NWC interest accruals: for EARN CARRY currencies (r_FCY > r_USD) automate buffer sizing to hold maximum pre-position; for PAY CARRY currencies minimize buffer to reduce opportunity cost
- [ ] Net swap position in balance sheet: confirm I+J=0 netting treatment in NP accounting; add swap overlay column showing net balance sheet impact per currency

## Active Blockers

<!-- Keep current — resolve or escalate within 24h of identifying -->
None.

## Stakeholders

<!-- Who needs to be informed about decisions or incidents? -->
| Name | Role | Contact |
|------|------|---------|
| TODO | TODO | TODO    |

## Key Links

<!-- Jira/Linear board, Slack channel, design docs, runbooks, staging URL -->
- Linear board: TODO
- Slack channel: TODO
- Staging: TODO
