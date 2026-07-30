# Treasury Department Overview

## Mission

Treasury manages global cash, FX risk, payments infrastructure, and financial operations across all group entities.

## Divisions

- **FX Team** — FX hedging, exposure management, VAR modelling
- **Payments** — Rails, payment routing, settlement
- **Cash Management** — Liquidity, notional pooling, yield optimization
- **Accounting** — NetSuite, reconciliation, journal entries

## Cross-team standards

- All financial data access goes through Treasury MCP or Public MCP — no direct DH queries
- All model outputs must be reviewed before execution in production systems
- Code touching payment logic requires two-engineer sign-off

## Escalation

- On-call: check #treasury-oncall Slack channel
- Data incidents: escalate to treasury engineering within 30 min
