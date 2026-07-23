# FX Team — Policies

## Branching strategy

- Main branch: main — protected, requires PR + review
- Development: dev — integration branch, auto-merges to main via draft PR
- Features: feature/<ticket-id>-<short-description>

## Deployment gates

- No FX model changes deploy on Friday or before a public holiday
- All hedging logic changes require UAT sign-off from FX Lead
- Production FX parameters (thresholds, limits) require dual approval

## On-call

- Rotation: FX team members rotate weekly
- Alerting: PagerDuty to #treasury-fx-oncall Slack
- SLA: P1 (system down) 30 min, P2 (data stale) 4 hours, P3 (model drift) next business day

## Incident process

1. Acknowledge PagerDuty within 15 min
2. Post status in #treasury-fx Slack
3. Open incident doc in GDrive: TREASURY/04 FX/Incidents/
4. Resolve + write post-mortem within 48 hours

## FX trade limits

- Automated hedges: up to $10M notional without manual approval
- Above $10M: requires FX Lead + CFO approval
- Options: always require FX Lead sign-off regardless of notional
