# Database checklist — PostgreSQL and Sequelize

PostgreSQL and Sequelize are the only approved database and ORM here. Do not introduce another one.

---

## 1. What to store from Treasury — decide this first

This section is a **soft rule**. It does not block the review. It does force a conscious choice,
and the choice must be recorded.

Treasury is the system of record. Every copy this application keeps is a copy that can drift from
it. Consider these options **in this order**, and treat the first two as the primary candidates:

| Option | When it fits |
|---|---|
| **1. Store nothing.** Query Treasury on demand. | Default. Pick this unless something concrete rules it out. |
| **2. Store only the aggregate you need.** | The value is expensive to recompute, or the view needs history Treasury does not expose cheaply. Store the derived number, not the rows behind it. |
| **3. Store raw Treasury data.** | Needs an explicit written reason. |

- [ ] The change states which option it took.
- [ ] If it took option 3, the reason is recorded in `.claude/rules/project/decisions.md` through
      `fx-record-decision`.

**Say the cost out loud when reviewing this.** Do not just tick the box:

- A stored copy **desynchronises** from the system of record. Treasury changes; your row does not.
  Every consumer of that row is now reading a number that was true at an unknown past moment.
- Every stored copy is **new attack surface** and **new compliance scope**. Financial data at rest
  must be encrypted, access-controlled, retained and eventually deleted. Data you never stored needs
  none of that.
- The principle is data minimisation: the less data you hold, the fewer opportunities there are for
  it to be misused. This is why "store nothing" is the default and not a compromise.

The operator working with the code makes the call. The reviewer's job is to make sure the call was
made deliberately, with the trade-off on the table — not by accident because storing felt easier.

Source: `.claude/rules/dept/compliance.md` → worker contract data is accessed through the MCP layer,
no caching; `CLAUDE.md` → Financial Data Handling. Data-minimisation reasoning follows standard
privacy-engineering practice.

## 2. Schema changes

- [ ] `sync({ force: true })` and `sync({ alter: true })` never appear in application code.
      `force` drops data; `alter` silently rewrites a live schema. Either is CRITICAL, anywhere.
- [ ] A bare `sync()` — create-if-missing — is the pattern this repository already uses in eleven
      places. **Read section 7 before flagging one.** It is a note, not a CRITICAL.
- [ ] A schema change to an **existing** table stops the review. Section 7 explains why there is no
      safe mechanism for it here yet.
- [ ] Models declare explicit column types and constraints.
- [ ] Associations are declared in **both** directions.

## 3. Queries

- [ ] Every `findOne` / `findAll` has an explicit `where`. Nothing relies on implicit filtering.
- [ ] Every query is scoped by tenant, organisation or user — **not by primary key alone**.

```ts
// correct
await User.findOne({ where: { id, organizationId } });

// wrong — missing scope
await User.findByPk(id);
```

- [ ] No value is string-concatenated into a query. Everything is parameterised through the ORM,
      including raw `sequelize.query` calls, which use bind parameters.
- [ ] `sequelize.literal()` never embeds user-supplied input.
- [ ] Columns used in `WHERE`, `JOIN` or `ORDER BY` are indexed.
- [ ] No N+1: related rows come from `include`, not from a query inside a loop.

Source: `CLAUDE.md` → Database Best Practices.

## 4. Transactions — know what "multi-step" means here

Multi-step writes use a transaction. But a Sequelize **managed** transaction has a trap that has
already bitten this codebase:

```ts
await sequelize.transaction(async (t) => {
  await row.destroy({ transaction: t });
  if (somethingIsWrong) throw new Error('…'); // <-- the destroy is rolled back too
});
```

The `destroy()` already ran, and it still gets rolled back, because the callback threw afterwards.

- [ ] If a write must survive even when the caller wants to signal an error, the callback
      **returns a sentinel** and the throw happens **after** the transaction has resolved.
- [ ] No `throw` inside a managed transaction callback whose earlier writes are meant to persist.

Source: `CLAUDE.md` → Database Best Practices.

## 5. Credentials and access

- [ ] Database credentials come from environment variables, never from source.
- [ ] The application's database user has no more grants than the application needs.

## 6. Redis

Redis is not used in this project. If a change introduces it:

- [ ] The client is `ioredis`, or `bullmq` for job queues. Not `redis`, not `@redis/client`, not
      `@upstash/redis`, not `node-redis`.
- [ ] The connection reads `REDIS_URL`.
- [ ] The new environment variable is added to `.env.example` and the README table in the same
      change — see `check-env-vars.md`.

Note that adding Redis means financial or session material may now sit in a second store. The
encryption-at-rest rules in `check-security.md` apply there too: the threat model is "the store
leaks on its own", and that includes Redis.

Source: `CLAUDE.md` → Tech Stack and Redis Patterns.

## 7. Known state of this repository — read before reporting section 2

Section 2 says any `sync(` in application code is CRITICAL. **Read this before applying it.**

This repository manages its schema with **bare `sync()` as create-if-missing**, and keeps
`lib/db/migrations/*.cjs` as *documentation* of the intended schema. There is **no migration
runner installed** — no `sequelize-cli`, no `umzug`, nothing in `package.json` that executes those
files. Eleven call sites already do this on `dev`:

| File | Calls |
|---|---|
| `lib/db/models/desk.ts` | 6 (`DeskWorkspace`, `DeskFxBook`, `DeskLiquidity`, `DeskAnalytics`, `DeskHedge`, `DeskAction`) |
| `lib/db/models/user-progress.ts` | 3 |
| `lib/db/models/sandbox-progress.ts` | 1 |
| `lib/db/models/treasury-oauth-token.ts` | 1 |

Two of the four files say so explicitly — `sandbox-progress.ts` and `treasury-oauth-token.ts`
carry "Creates the table if missing — no force/alter". The nine calls in `desk.ts` and
`user-progress.ts` carry **no comment at all**; they follow the same pattern, but that is inferred
from the code, not stated by it.

**So split your section 2 findings:**

| What you see | Severity |
|---|---|
| bare `sync()` in an existing model file, create-only | **note**, not CRITICAL — this is the established pattern |
| `sync({ force: true })` or `sync({ alter: true })`, anywhere | **CRITICAL**, no exception — `force` drops data, `alter` silently rewrites a live schema |
| a **new** model added with bare `sync()` | note, but ask in the review whether the schema story below still holds |
| a schema **change to an existing table** (new column, changed type) | **CRITICAL** — see the open question below |

Without this split, the first review touching `lib/db/` returns eleven pre-existing CRITICALs the
change did not cause, `fx-review` forbids downgrading them, and `fx-implement` hard-stops after
three rounds. That is the same failure `check-financial.md` section 9 exists to prevent for float
arithmetic, and it was latent here too.

### Open question — flag it, do not guess

`sync()` creates a missing table. It does **not** alter an existing one, and no runner applies the
migration files. So **there is no written answer to "how do I add a column to a live table"**, and
a person who needs one will invent something — the most likely inventions being `sync({ alter })`
(rewrites a live schema, CRITICAL) or a hand-run `ALTER TABLE` against a shared database.

If a change needs a schema change to an existing table, **stop and raise it**. Do not pick a
mechanism on your own. The answer needs to be decided once and recorded in `decisions.md`, and it
is not recorded yet.

Source: `CLAUDE.md` → Database Best Practices (migrations, never `sync({ force: true })` in
production); the state of `lib/db/models/` and `lib/db/migrations/` on `dev` as of 2026-08-24.
