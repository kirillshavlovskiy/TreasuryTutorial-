# Classification — which checklists apply

Match every changed file against the tables below. One file can select more than one checklist.
Collect the union, then read only those `check-*.md` files.

The paths here describe **this repository as it actually is**: the code lives in `lib/`, `app/` and
`components/`. There is no `src/`. If a document ever disagrees with this table, check the
filesystem before trusting either.

## Forbidden paths — stop the review

If a changed file matches any row here, report it and **stop**. Do not review the rest of the diff.

| Path | Why |
|---|---|
| `helm/**` | platform-managed; changing it breaks the deploy pipeline |
| `argocd/**` | platform-managed |
| `.github/**` | platform-managed |
| `Dockerfile` | platform-managed |
| `values.yaml` | platform-managed |
| `.claude/rules/dept/**` | department knowledge, read-only, arrives by `/sync-dept` |
| `.claude/rules/div/**` | division knowledge, read-only, arrives by `/sync-division` |

Match on the **path suffix**, not the prefix. A file at
`.claude/worktrees/some-branch/helm/values.yaml` is still `helm/values.yaml`.

`.claude/rules/project/**` is **not** forbidden. Those files are editable by the team.

Report it like this:

> STOPPED. `<path>` is a protected path (`<reason>`). Revert this file, then run the review again.
> Source: `CLAUDE.md` → "What NOT to do"; framework layer rules.

## Path table

| Path pattern | Checklists |
|---|---|
| `lib/fx-*.ts` | financial |
| `lib/carry-*.ts`, `lib/cash-*.ts`, `lib/cfar-*.ts`, `lib/cycle-*.ts` | financial |
| `lib/formula.ts`, `lib/sim-formulas.ts`, `lib/dashboard-model.ts` | financial |
| `lib/forecast-*.ts`, `lib/liquidity-*.ts` | financial |
| `lib/portfolio-alloc.ts` | financial — allocates the carry VaR budget |
| `lib/hedge-book-normalize.ts` | financial |
| `lib/test-mode/**` | financial |
| `lib/treasury/**` | financial, security |
| `lib/db/**` | database, security |
| `lib/s3.ts` | security |
| `lib/db/models/**` | database, typescript |
| `lib/agent/**` | security, typescript |
| `app/api/**` | nextjs-api, security |
| `app/api/auth/**` | security |
| `app/api/treasury/**` | security, financial |
| `app/**/*.tsx`, `components/**` | nextjs-api, typescript |
| `components/*Buffer*.tsx`, `components/*Swap*.tsx`, `components/*Hedg*.tsx`, `components/*Liquidity*.tsx` | financial, nextjs-api |
| `**/*.test.ts`, `**/*.test.tsx` | tests |
| `.env.example`, `README.md` | env-vars |
| `auth.ts`, `next.config.ts` | security, env-vars |
| `package.json` | security |
| `**/*.ts`, `**/*.tsx` (catch-all) | typescript |

## Content signals

Also scan the diff body. These add checklists regardless of path.

| Signal in the changed lines | Adds |
|---|---|
| `parseFloat(`, `Number(`, `+`, `-`, `*`, `/` applied to an amount, balance, rate or notional | financial |
| `new Decimal`, `Decimal(` | financial — confirm the whole calculation stays in Decimal |
| `toFixed(`, `Math.round(`, `Math.floor(` on money | financial |
| `console.log`, `console.error`, or any logger call with an amount, balance, rate, account id or counterparty in scope | financial |
| a Treasury MCP tool name that writes (see `check-financial.md`) | financial — CRITICAL |
| `findByPk(`, `findAll(`, `findOne(`, `sequelize.query(`, `sequelize.literal(` | database |
| `sequelize.transaction(` | database |
| `@Table`, `@Column`, `DataTypes.` | database, typescript |
| `createCipheriv`, `createDecipheriv`, `randomBytes`, `crypto.` | security |
| `cookies().set`, `cookies().delete`, `Set-Cookie` | security |
| `auth(`, `session`, `token`, `jwt` | security, nextjs-api |
| `process.env.` added, renamed or removed | env-vars |
| `as ` type assertion inside a `*.test.ts` file | tests — CRITICAL |
| `any` | typescript |
| `sync({ force`, `sync({ alter` on a Sequelize model | database — CRITICAL |
| bare `sync()` on a Sequelize model | database — see `check-database.md` section 7 before flagging |

## Worked example

Changed files:

```
lib/fx-buffer.ts
lib/fx-buffer.test.ts
app/api/treasury/fx-rates/route.ts
.env.example
```

Selected checklists: `financial` (from `lib/fx-*.ts` and `app/api/treasury/**`),
`tests` (from `*.test.ts`), `nextjs-api` and `security` (from `app/api/**`),
`env-vars` (from `.env.example`), `typescript` (catch-all).

Not selected: `database` — nothing under `lib/db/**` changed and no query signal appeared.
