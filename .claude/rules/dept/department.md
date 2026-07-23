# Treasury Department Overview

## Mission

Deel Treasury manages global cash, FX risk, payments infrastructure, and financial operations across all Deel entities.

## Divisions

- **FX Team** — FX hedging, exposure management, VAR modelling
- **Payments** — Rails, payment routing, settlement
- **Cash Management** — Liquidity, notional pooling, yield optimization
- **Accounting** — NetSuite, reconciliation, journal entries

## Cross-team standards

- All financial data access goes through Deel Treasury MCP or Deel Public MCP — no direct DH queries
- All model outputs must be reviewed before execution in production systems
- Code touching payment logic requires two-engineer sign-off

## Escalation

- On-call: check #treasury-oncall Slack channel
- Data incidents: escalate to treasury-eng@deel.com within 30 min
