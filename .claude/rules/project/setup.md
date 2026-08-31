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

There is **one** list of environment variables, and it lives in two places that are kept in
sync: `.env.example` (with the long per-variable notes) and the Environment Variables table in
`README.md`. Do not start a third list here — a second copy drifts, and `CLAUDE.md` forbids it.

Copy `.env.example` to `.env.local` and fill in values. Never commit `.env.local`.

Check the two sources still agree:

```bash
node .claude/skills/fx-review/scripts/env-drift.mjs
```

## Repository Structure

```
app/            Next.js App Router — pages and API routes (app/api/**)
lib/            Business logic: FX/buffer/VaR calculators, db access, Treasury client, agent
components/     React components, including the simulator and workbench screens
data/           Static data files
docs/           Architecture notes and runbooks
scripts/        Operational scripts — never imported by application code
public/         Static assets
.claude/skills/ Agent skills for this repo — see .claude/skills/README.md
.claude/hooks/  Deterministic guards (protected paths)
```

Unit tests are co-located with their source: `lib/fx-buffer.ts` → `lib/fx-buffer.test.ts`.

See `engineering.md` for naming conventions.

## CI/CD

TODO: How does this deploy? (Vercel / GitHub Actions / etc.)

## Known Gotchas

<!-- Things that have burned people before. Add immediately when discovered. -->
- TODO
