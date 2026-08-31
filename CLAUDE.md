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

## Environment Variables — keep in sync

`.env.example` and the Environment Variables table in `README.md` must always describe the exact same set of variables. Whenever a change adds, renames, removes, or changes the requiredness of an environment variable (including one only read implicitly by a library, e.g. NextAuth's `AUTH_SECRET` or the AWS SDK's credential chain):

- Add/update the entry in `.env.example` (with its generation command or default, if any) in the same change.
- Add/update the matching row in `README.md`'s Environment Variables table in the same change — do not defer this to a follow-up.
- Note explicitly whether the app runs without it (degrades a specific feature) or fails outright, matching the Required column convention already used in the README table.
- Before adding a *new* table or list of env vars elsewhere (e.g. in `.claude/rules/project/setup.md`), check whether one already exists — point to the existing one instead of creating a second copy that can drift.

A `git grep -oE "process\.env\.[A-Za-z_][A-Za-z0-9_]*"` (restricted to `app/`, `lib/`, `components/`, `auth.ts`, config files — exclude `node_modules`, `.next`, `.claude/worktrees`, and `*.test.ts`) is the fastest way to audit for drift, but it will miss vars a library reads on its own from `process.env` without an explicit reference in this codebase — check `.env.example`'s existing entries for those before assuming grep's result is the complete list.

---

## Code Style

- Prefer explicit types — avoid `any`; use `unknown` and narrow it
- Keep functions small and single-purpose
- No dead code, commented-out blocks, or unused imports
- Use `async/await` over raw Promise chains
- Avoid over-engineering: no abstractions for one-time use, no premature generalization
- Don't let one function silently reinterpret/coerce its input to mean something
  different from what the caller expects (e.g. a parser normalizing an enum value
  "just to be safe"). If two call sites genuinely need different normalization
  rules for the same shape, that's two functions with two names, not one function
  with a hidden special case — a case exactly like this reached production and
  silently broke a scoring path (see `decisions.md`)
- Test fixtures must satisfy the real type, not `as SomeType` past it. A cast that
  papers over missing required fields hides exactly the bugs types exist to catch;
  when a fixture is annoying to build by hand, reuse the real production
  constructor/factory instead of hand-rolling and casting a partial object
- Type errors (`tsc --noEmit`) are part of "done," not noise — a type mismatch in
  test code is usually either a real bug in the fixture or a real bug in the
  function under test, and it's worth finding out which before suppressing it

---

## Security

Never hardcode secrets, tokens, or credentials — use environment variables. Validate all external input at API boundaries (user input, webhooks, query params). Sanitize before interpolating into queries — never build raw SQL strings. Do not log sensitive data (tokens, passwords, PII, account numbers). Keep dependencies up to date; flag known-vulnerable packages — if a scanner reports a finding with no fix available (registry stuck on the last vulnerable version), that's a decision to make and document, not a warning to ignore.

**Encryption at rest**
- Any secret or credential persisted outside the request that issued it (OAuth tokens, API keys, session material) must be encrypted at rest with an AEAD cipher — **AES-256-GCM**, not a plain block cipher, and not something hand-rolled. Never store plaintext secrets in a database row, even if the database itself is access-controlled — the threat model is "the DB (or a backup, or a replica, or Redis if one is added) leaks on its own," where the app's access control is already bypassed
- A fresh random IV/nonce per encryption call, never reused across encryptions under the same key
- Use Associated Data (AAD) to bind a ciphertext to its purpose when one key encrypts more than one kind of secret, so a ciphertext stolen from context A can't be replayed as valid in context B — see `lib/treasury/crypto.ts` for the pattern
- Tag ciphertext with an envelope/algorithm version and support decrypting under a previous key during rotation. Don't assume today's key (or algorithm) never needs to change — design so a key rotation is an operational action, not a data migration
- **Do not reach for post-quantum algorithms for symmetric-key, single-party encryption** (a server encrypting its own data with a key it already holds — no key exchange, no signature). AES-256 already keeps ~128-bit security against a quantum adversary (Grover's algorithm only gives a quadratic speedup against symmetric ciphers) — this is the same margin NIST's PQC guidance targets. Shor's algorithm threatens *asymmetric* crypto (RSA/ECC key exchange and signatures); that risk lives in TLS negotiation, which the platform/runtime handles, not in application code. Bolting a KEM like ML-KEM onto a use case that has no asymmetric step adds real complexity for a threat that isn't there — if you're unsure whether a specific design needs PQC, ask before implementing one

**Auth & sessions**
- Server-to-server OAuth (Authorization Code + PKCE) for anything beyond a simple login: random `state` (CSRF) and `nonce` (id_token replay) per attempt, single-use, short TTL
- Cookies carrying session or OAuth-flow state: `httpOnly`, `Secure`, explicit `SameSite`, and an explicit `path` that matches between `set` and `delete` — a mismatched path means the delete silently no-ops (RFC 6265 identity is name+domain+path)
- Fail closed: on any auth/decrypt/verification failure, deny and log — never fall back to trusting unverified data because verification was inconvenient
- Rate-limit and audit-log security-sensitive endpoints (auth, token refresh/disconnect, anything that moves money)

---

## Database (PostgreSQL / Sequelize) Best Practices

- Use **migrations** for all schema changes — never `sync({ force: true })` in production
- Define models with explicit column types and constraints
- Use transactions for multi-step writes — and know exactly what "multi-step" means for Sequelize: a managed transaction (`sequelize.transaction(async (t) => {...})`) **rolls back everything, including a `destroy()`/`update()` that already ran**, if the callback throws afterward for any reason. If a write must survive even when the caller wants to signal an error to its own caller, return a sentinel from the callback and throw only after the transaction has resolved — don't throw inside it
- Use `findOne` / `findAll` with explicit `where`, never rely on implicit filtering — always scope by tenant/org/user, not just by primary key
- Associations must be declared in both directions
- Index columns used in `WHERE` / `JOIN` / `ORDER BY`; watch for N+1 (use `include`, not a query-per-row loop)
- DB credentials are least-privilege per environment — the app's own DB user should not have more grants than the app needs
- Never string-concatenate values into a query — parameterize via the ORM/query builder even for raw `sequelize.query` calls

```ts
// correct
await User.findOne({ where: { id, organizationId } });

// wrong — missing scope
await User.findByPk(id);
```

---

## Financial Data Handling

This app processes financial data (balances, rates, hedges, exposures). Treat it accordingly:

- **Never use native floating-point arithmetic for money or FX rates** — use `Decimal.js` (or equivalent) for any calculation that aggregates, converts, or compares monetary amounts. A float rounding error in a hedging calculation is a production incident, not a cosmetic bug
- Every rate value carries an explicit currency code (ISO 4217, uppercase) and an explicit timestamp/source — no implicit "current rate," no numeric currency codes
- Log the *decision*, not just the *result*, for anything that sizes or executes a financial position — audit trail entries should let someone reconstruct why a number was what it was
- Respect configured approval thresholds in code, not just in policy docs — if a limit exists, the code path that could exceed it should hard-stop, not warn
- Account identifiers, balances, and counterparty data are sensitive — encrypt at rest where persisted, never log in plaintext, never put in a URL query string
- Financial writes (trade execution, hedge booking, token issuance) must be idempotent — a retried request must not double-book

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

## Working with AI-Generated Code

Rules to keep vibe-coded changes from quietly degrading quality or security in a codebase handling financial data:

- After any AI-generated change: typecheck, run the full test suite, and — for financial logic specifically — hand-verify at least one real number. A green test suite proves the code matches the tests, not that the tests were right; tests built on `as Type`-cast fixtures can pass while hiding a real gap (this happened in this repo — see `decisions.md`)
- Before "fixing" a failing test, determine whether the bug is in the implementation or the test. A failing test is a symptom; changing the assertion to match current behavior is only correct if that behavior is actually intended — check git history/blame and trace what else depends on the current behavior before deciding
- Before changing a shared function's behavior (renaming, retyping, changing a return value's meaning), grep for every caller — an AI assistant fixing one call site can silently break another it didn't look at
- Don't accept new dependencies, patterns, or abstractions an assistant introduces beyond what the task needed — every new library is new attack surface and new audit burden; see "Tech Stack" above
- Don't trust a third-party library's TypeScript types as ground truth for its runtime behavior — community type definitions can be wrong or narrower than what the library actually does (and vice versa); verify empirically against the library's own docs/tests when a type error looks suspicious
- Security- and deployment-sensitive files (`Dockerfile`, `.github/`, `helm/`, `argocd/`, anything under `.claude/rules/dept/` or `.claude/rules/div/`, encryption/crypto code, auth flows) get a human review pass — don't let "the assistant already checked it" substitute for that

---

## What NOT to do

- Do not add features beyond what was asked
- Do not refactor surrounding code unless it directly blocks the task
- Do not add docstrings or comments to code you did not change
- Do not create helper utilities for one-off operations
- Do not add backwards-compatibility shims for removed code
- **Never modify deployment-related files** — the `helm/` folder, `.github/` folder, `argocd/` folder, `values.yaml`, and `Dockerfile` are managed by the platform and must not be changed, as doing so can break the deployment pipeline

# Knowledge framework — read this before anything else

This project uses the Deel Treasury three-layer shared knowledge framework.
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
