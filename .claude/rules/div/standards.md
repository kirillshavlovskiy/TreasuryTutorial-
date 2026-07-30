# FX Team — Code Standards & PR Checklist

## Code standards

- All FX calculations must use Decimal.js — never native float arithmetic
- Currency codes: ISO 4217 uppercase strings (USD, EUR) — never numerics
- All rate lookups must specify a timestamp — no implicit 'current rate'
- Hedging logic: every trade decision must log rationale to audit trail
- Rounding: amounts round to 2 decimal places; FX rates round to 4 decimal places, or 6–8 decimal places when source data provides that precision

## Naming conventions

- FX exposure variables: exposureAmount, hedgeRatio, varEstimate
- File naming: fx-*.ts for FX-specific modules
- Test files: *.test.ts co-located with source

## PR checklist

- [ ] No float arithmetic for financial amounts
- [ ] Rate source and timestamp documented
- [ ] Edge cases tested: zero exposure, single-currency portfolio
- [ ] Audit log entry added for any trade decision
- [ ] Reviewed by FX lead if touching hedging strategy logic

## Testing requirements

- FX unit tests: cover rate conversion, exposure aggregation, hedge ratio calculation
- Integration tests: use Treasury MCP sandbox
- VAR model tests: validate against known historical scenarios
