# Compliance & Data Handling — Treasury

## Data classification

- Payment data: RESTRICTED — never log amounts, account numbers, or transaction IDs in plaintext
- FX rates: INTERNAL — may be shared within the organization, not externally
- Worker contract data: CONFIDENTIAL — access via Public MCP only, no caching

## Security rules

- No hardcoded credentials — use environment variables or secret manager
- No storing API tokens in code or .env files committed to git
- MCP tools are the approved channel for all external data access

## Regulatory

- All FX transactions above $1M require pre-trade compliance check
- Hedging strategies must be documented and approved before implementation
- Audit logs must be retained for 7 years

## Incident response

1. Contain — disable the affected integration
2. Assess — identify data exposure scope
3. Report — notify treasury security within 1 hour
4. Document — file incident report within 24 hours
