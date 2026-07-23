# Engineering Standards — Treasury

## Code style

- TypeScript for all new code — strict mode enabled
- ESLint + Prettier enforced via CI
- No `any` types — use proper interfaces or `unknown`

## API conventions

- All external calls go through MCP tools — no raw HTTP to Deel APIs
- Pagination: always handle `nextPageToken` / cursor patterns
- Errors: wrap in typed result objects, never swallow

## Review standards

- PRs require one reviewer minimum — two for payment-path changes
- All PRs must include test coverage for new logic
- Link to the relevant Linear ticket in PR description

## Testing

- Unit tests for all business logic
- Integration tests must hit real MCP endpoints (no mocking)
- Test data must use sandbox/staging environments only

## Deployment

- Feature flags for all new financial features in production
- Canary deploy before full rollout on payment-critical paths
- Rollback plan documented in PR before merging
