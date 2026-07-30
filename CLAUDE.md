# Claude Code — Project Guidelines

## Tech Stack (non-negotiable)

| Layer     | Technology          |
|-----------|---------------------|
| Framework | **Next.js** (App Router) |
| Database  | **PostgreSQL** only  |
| ORM       | **Sequelize** only   |
| Cache / queue | **ioredis** or **bullmq** only (if Redis is used) |
| Language  | **TypeScript** (strict) |

Do not introduce alternative frameworks, databases, ORMs, or Redis clients. If a library conflicts with this stack, find a compatible one or raise it with the team.

---

## Code Style

- Prefer explicit types — avoid `any`; use `unknown` and narrow it
- Keep functions small and single-purpose
- No dead code, commented-out blocks, or unused imports
- Use `async/await` over raw Promise chains
- Avoid over-engineering: no abstractions for one-time use, no premature generalization

---

## Security

- Never hardcode secrets, tokens, or credentials — use environment variables
- Validate all external input at API boundaries (user input, webhooks, query params)
- Sanitize before interpolating into queries — never build raw SQL strings
- Do not log sensitive data (tokens, passwords, PII)
- Keep dependencies up to date; flag known-vulnerable packages

---

## Sequelize Patterns

- Use **migrations** for all schema changes — never `sync({ force: true })` in production
- Define models with explicit column types and constraints
- Use transactions for multi-step writes
- Use `findOne` / `findAll` with explicit `where`, never rely on implicit filtering
- Associations must be declared in both directions

```ts
// correct
await User.findOne({ where: { id, organizationId } });

// wrong — missing scope
await User.findByPk(id);
```

---

## Next.js Patterns

- Use the **App Router** (`app/` directory) — no Pages Router additions
- API routes live in `app/api/` and must always validate the session first
- Use `getServerSession` for auth — never trust client-passed user IDs
- Prefer server components; use `"use client"` only when interactivity is required
- Do not fetch data in client components if it can be done server-side

---

## Git Workflow

- Use **Conventional Commits**: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`
- One logical change per commit — do not bundle unrelated changes
- Never commit directly to `main` or `dev` — open a pull request
- Never skip pre-commit hooks (`--no-verify`)
- Never force-push to shared branches

---

## Error Handling

- API routes must return structured JSON errors with appropriate HTTP status codes
- Do not swallow errors silently — log them with enough context to debug
- Use try/catch around all external calls (GitHub API, DB, third-party services)
- Surface partial failures in the response rather than masking them

## Redis Patterns

Redis is provisioned automatically when `ioredis` or `bullmq` is detected in `package.json`. The pod runs `public.ecr.aws/docker/library/redis:7.4-alpine` with no authentication.

- Connect using the `REDIS_URL` environment variable — it is injected automatically (`redis://<sandbox>-redis:6379`)
- Use **ioredis** as the Redis client — it is the only approved direct client
- Use **bullmq** for job queues — it uses ioredis internally
- Do **not** use `redis` (`@redis/client`), `@upstash/redis`, `node-redis`, or any other Redis library — the tech scan will reject them
- Redis has no password — do not attempt to configure auth

```ts
// correct
import Redis from "ioredis";
const redis = new Redis(process.env.REDIS_URL!);

// correct (job queue)
import { Queue, Worker } from "bullmq";
const queue = new Queue("my-queue", { connection: { url: process.env.REDIS_URL } });

// wrong — unapproved client
import { createClient } from "redis";
```

---

## What NOT to do

- Do not add features beyond what was asked
- Do not refactor surrounding code unless it directly blocks the task
- Do not add docstrings or comments to code you did not change
- Do not create helper utilities for one-off operations
- Do not add backwards-compatibility shims for removed code
- **Never modify deployment-related files** — the `helm/` folder, `.github/` folder, `argocd/` folder, `values.yaml`, and `Dockerfile` are managed by the platform and must not be changed, as doing so can break the deployment pipeline

# Knowledge framework — read this before anything else

This project uses the Treasury three-layer shared knowledge framework.
You must understand the layers before acting on any instruction.

## Framework documentation (above all layers — always auto-fetched)

The two files below are framework-level reference docs. They sit OUTSIDE the dept/div/project hierarchy.
They are fetched from Google Drive on every `/sync-dept` run and always overwritten — never edited manually.

@.claude/framework-readme.md
@.claude/framework-setup.md

---

## Knowledge model

DEPARTMENT knowledge → lives in Google Drive (Treasury/) → synced to .claude/rules/dept/
DIVISION knowledge   → lives in Google Drive (FX Team/)  → synced to .claude/rules/div/
PROJECT knowledge    → lives in this repo                → .claude/rules/project/

## Layer rules

LAYER 1 — dept/ (read-only — GDrive Treasury/)
- Source: official policies, compliance rules, department-level engineering standards
- Owner: department head — maintained in Google Drive Knowledge Base
- NEVER suggest editing any file under .claude/rules/dept/
- If content seems outdated: tell the user to run /sync-dept
- Sync uses: Google Drive MCP

LAYER 2 — div/ (read-only here — editable in GDrive)
- Source: division standards, code style, PR checklist, team guidelines
- Owner: team lead — maintained in Google Drive (FX Team/)
- NEVER suggest editing any file under .claude/rules/div/
- If content seems outdated: tell the user to run /sync-division
- Sync uses: Google Drive MCP

LAYER 3 — project/ (editable by all team members)
- Source: this project's context, decisions, and setup — lives in this repo
- Owner: all developers
- CAN and SHOULD suggest updates when decisions are made or context changes
- Update directly and commit alongside the related code change

## Precedence

dept/ compliance rules always win over all other instructions.
div/ standards apply unless project/ explicitly overrides for this codebase.
project/ context applies to this codebase only.

## Sync commands (slash commands inside Claude Code)

/init             — full initialization: fetches framework docs + dept + div knowledge from GDrive
/sync-dept        — fetches from GDrive Treasury/ → writes .claude/rules/dept/
                    also always re-fetches framework-readme.md and framework-setup.md
/sync-division    — fetches from GDrive FX Team/  → writes .claude/rules/div/ and .claude/rules/project/

## When project knowledge needs updating

1. Complete the coding task first
2. Say: "I noticed [X] is not captured in project knowledge. Should I update [file]?"
3. Wait for confirmation, then write ONLY to .claude/rules/project/ files
4. Never touch dept/ or div/ files — those are sync-managed

# End of framework notation

@.claude/rules/dept/department.md
@.claude/rules/dept/compliance.md
@.claude/rules/dept/engineering.md

@.claude/rules/div/division.md
@.claude/rules/div/standards.md
@.claude/rules/div/policy.md
@.claude/rules/div/fx-hedging-policy.md
@.claude/rules/div/fx-hedging-strategy.md

@.claude/rules/project/context.md
@.claude/rules/project/decisions.md
@.claude/rules/project/setup.md
@.claude/rules/project/engineering.md
