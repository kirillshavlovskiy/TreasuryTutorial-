# Project Setup

> Maintained by: all team members
> Update immediately when setup steps, env vars, or gotchas change.
> A stale setup.md causes new team members and Claude to make wrong assumptions.

## Prerequisites

- Node.js v20+ (`node --version`)
- npm v10+ (`npm --version`)
- TODO: Add any other prerequisites (Docker, gcloud, etc.)

## Install

```bash
npm install
```

## Development

```bash
npm run dev
```

## Build

```bash
npm run build
```

## Test

```bash
npm test                    # all tests
npm test -- --watch         # watch mode
npm test -- <pattern>       # single file or pattern
```

## Environment Variables

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| TODO     | TODO        | Yes      | TODO    |

Copy `.env.example` to `.env.local` and fill in values. Never commit `.env.local`.

## Repository Structure

```
src/lib/        Pure business logic (calculators, transformers)
src/services/   External integrations (MCP calls, HTTP clients)
src/api/        Route handlers / controllers
src/types/      Shared TypeScript interfaces and enums
tests/          Integration and e2e tests
docs/           Architecture diagrams, runbooks
scripts/        Operational scripts — never imported by src/
```

See `engineering.md` for full structure and naming conventions.

## CI/CD

TODO: How does this deploy? (Vercel / GitHub Actions / etc.)

## Known Gotchas

<!-- Things that have burned people before. Add immediately when discovered. -->
- TODO
