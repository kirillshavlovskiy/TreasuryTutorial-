# test-treasury-project

TODO: add project description

## Setup

See [.claude/framework-setup.md](.claude/framework-setup.md) for full setup instructions.

## Development

```bash
npm install
npm run dev
```

## Local development stack

`npm run dev` starts Postgres, Redis and an S3-compatible store first, through
`docker compose`, and then fills in the connection strings. There is no separate
command to remember and nothing to configure by hand.

The only prerequisite is a running container runtime — Docker Desktop, Rancher
Desktop or Colima. Without one the app still starts: sandbox and desk state fall
back to browser-only persistence, the execution journal is not saved at all (the
browser console says so once), and the script says so instead of failing.

| Service | Host port | Stands in for |
|---------|-----------|---------------|
| Postgres 16 | 5432 | the managed CloudNativePG instance the cluster provisions |
| Redis 7.4 | 16379 | the cluster's Redis deployment — same image version, same `--save "" --appendonly no` arguments, no authentication |
| MinIO (S3 API) | 9000 | the real AWS S3 bucket the cluster reaches through IRSA |
| MinIO console | 9001 | — (browse the bucket at http://localhost:9001, minioadmin / minioadmin) |

```bash
npm run stack:up       # start and wait for health; configure .env.local
npm run stack:status   # what is running, and what the app will actually talk to
npm run stack:down     # stop (shared across every checkout — see handover docs)
```

Redis defaults to **16379**, not 6379. Ports can be moved with `FX_PG_PORT`,
`FX_REDIS_PORT`, `FX_MINIO_PORT` or `FX_MINIO_CONSOLE_PORT`. `STACK_SKIP=1`
skips the stack entirely. Those are read by the script, not by the app.

The script creates `.env.local` if missing and fills in `DATABASE_URL`,
`REDIS_URL`, `S3_ENDPOINT`, the `S3_*` settings and MinIO credentials. **It
never overwrites a value you have already set.** `AUTH_SECRET` is generated
when empty; `TOKEN_ENCRYPTION_KEY` is never invented. Existing Neon /
Vercel `DATABASE_URL` values keep winning — use `npm run stack:status` to see
what the app will actually connect to.

For a longer walkthrough of shared volumes, MinIO journal layout, and
production parity, see `docs/handover-order-execution-tape.md` and
`docs/handover-spot-tape.md`.

## Environment Variables

Copy `.env.example` to `.env.local` and fill in the values. This table and
`.env.example` describe the same set of variables and are kept in sync —
`.env.example` carries the longer per-variable notes.

Check for drift at any time:

```bash
node .claude/skills/fx-review/scripts/env-drift.mjs
```

### Authentication and session

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `AUTH_SECRET` | Auth.js session secret (`openssl rand -base64 33`). Alias: `NEXTAUTH_SECRET` | **Yes** — Google sign-in cannot work without it | — |
| `AUTH_URL` | Canonical origin for Auth.js and Treasury Okta `redirect_uri`. Alias: `NEXTAUTH_URL` | **Yes in production** — the app refuses to derive it from the `Host` header and throws | `https://ssigma.app` |
| `AUTH_GOOGLE_ID` | Google OAuth client ID | **Yes** — sign-in fails without it (or `GOOGLE_CLIENT_ID`) | — |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret | **Yes** — sign-in fails without it (or `GOOGLE_CLIENT_SECRET`) | — |
| `GOOGLE_CLIENT_ID` | Fallback Google OAuth client ID if `AUTH_GOOGLE_ID` is unset | No — used only when `AUTH_GOOGLE_ID` is empty | — |
| `GOOGLE_CLIENT_SECRET` | Fallback Google OAuth client secret if `AUTH_GOOGLE_SECRET` is unset | No — used only when `AUTH_GOOGLE_SECRET` is empty | — |
| `AUTH_ALLOW_INSECURE_TLS` | Relax TLS verification for Google OIDC discovery behind a corporate proxy | No — local dev only; ignored in production | `true` |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Written by `auth.ts` when `AUTH_ALLOW_INSECURE_TLS=true`. Do not set by hand | No | — |

### PostgreSQL (sandbox and desk snapshots)

Local docker-compose Postgres, Neon on Vercel, or any managed Postgres. Neon
hosts use the HTTPS/WSS driver on `:443` (`lib/db/sequelize.ts`); other URLs use
plain `pg`. The connection string is taken from the first of the four URL
variables that is set, in that order. The Neon/Vercel Marketplace integration
injects the `ssigma_*` names. Set only one.

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `DATABASE_URL` | Postgres connection string, first choice | No — without any URL, sandbox and desk state persist in the browser only | `postgres://postgres:postgres@localhost:5432/fx_test_project` |
| `ssigma_DATABASE_URL` | Same, second choice; injected by the Marketplace integration | No — same degradation as above | — |
| `POSTGRES_URL` | Same, third choice | No — same degradation as above | — |
| `ssigma_POSTGRES_URL` | Same, fourth choice | No — same degradation as above | — |
| `DATABASE_SSL` | Force SSL on the connection; Neon hosts and `sslmode=require` enable it anyway | No — inferred from the URL | `true` |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | Allow a self-signed certificate on the database connection | No — defaults to rejecting | `false` |
| `DATABASE_IP_FAMILY` | IP family for the connection: `6` selects IPv6, anything else IPv4 | No — defaults to IPv4 | `4` |
| `SANDBOX_STORAGE_ENV` | Force the storage partition instead of deriving it from `VERCEL_ENV` | No — `production` on Vercel production, `uat` elsewhere; `local` for the docker stack | `uat` |

### Redis

Provided by the local development stack. **Nothing in this codebase reads this
variable today** — documented so local and cluster values share the same shape.

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `REDIS_URL` | Redis connection string | No — unread by this codebase today | `redis://localhost:16379` |

### AI agent

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini API key for the Workbench and sandbox chat panels | No — without it the agent panel cannot answer | — |

### AWS S3 file storage

Credentials come from IRSA in the cluster and from the static `AWS_*` variables locally. The
SDK reads the three credential variables directly from the environment.

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `S3_BUCKET` | Playground bucket for uploaded market-rate files | No — uploads still parse and persist in the book without S3 | `deel-playgrounds-data` |
| `S3_PREFIX` | Prefix this project is restricted to inside the bucket | No — same degradation as above | `fx-test-project/` |
| `S3_REGION` | Bucket region | No — same degradation as above | `eu-west-1` |
| `S3_ENDPOINT` | S3-compatible endpoint instead of AWS (local MinIO); also forces path-style addressing | No — **must stay unset in the cluster** | `http://localhost:9000` |

### Recorded-tape store

The matcher writes the recorded tape to exactly one store. Unset means `s3`
(cluster). Local checkouts usually set `postgres` so the tape lands in
`leg_tape_ticks` without AWS credentials.

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `EXECUTION_STORE` | Where the recorded tape is written and read: `s3` or `postgres` | No — unset means `s3` | `postgres` |
| `TAPE_INTERVAL_MS` | Interval between tape ticks for the background matcher | No — defaults to `100` | `100` |

### Refinitiv IPA (Market data pull)

Server-side Quantitative Analytics proxy. Market data **Pull curve** / **Pull vol**
call `POST /api/forward-curves` and `POST /api/surfaces`. Without these vars the
buttons still work if you paste a live Bearer on the Market data tab.

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `REFINITIV_ACCESS_TOKEN` | Optional static Bearer (ignored once the JWT is expired) | No | — |
| `REFINITIV_CLIENT_ID` | App key for refresh / password grant | No — needed for a long-lived session | — |
| `REFINITIV_USERNAME` | Password grant | No | — |
| `REFINITIV_PASSWORD` | Password grant. Quote if it contains `#` | No | — |
| `REFINITIV_REFRESH_TOKEN` | Refresh grant (with `CLIENT_ID`) | No | — |
| `AWS_REGION` | Region for the AWS SDK when `S3_REGION` is not used | No — read by the SDK | `eu-west-1` |
| `AWS_ACCESS_KEY_ID` | Static credential for local use; read by the AWS SDK, not by this codebase | No — IRSA supplies credentials in the cluster | — |
| `AWS_SECRET_ACCESS_KEY` | Static credential for local use; read by the AWS SDK | No — same as above | — |
| `AWS_SESSION_TOKEN` | Static session credential for local use; read by the AWS SDK | No — same as above | — |
| `AWS_EC2_METADATA_DISABLED` | Skips the SDK's EC2 metadata probe. The app sets it to `true` itself when unset | No — set `false` only to opt the probe back in | `true` |

### Treasury OAuth (Okta) and Finance MCP

Without this whole block the app still runs: the book shows its static values and the header
badge reads "Connect Treasury" instead of going live.

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `OKTA_ISSUER` | Okta custom Authorization Server issuing the Finance MCP token | No — without it "Connect Treasury" returns 501 and the book stays static | `https://deel.okta.com/oauth2/<auth-server-id>` |
| `OKTA_CLIENT_ID` | This app's confidential (Web) OIDC client under that AS | No — same degradation as above | `0oa…` |
| `OKTA_CLIENT_SECRET` | Client secret for the token exchange (`client_secret_post`) | No — same degradation as above | — |
| `TREASURY_MCP_URL` | Treasury Finance MCP endpoint (Streamable HTTP, `POST /mcp`) | No — unset means the book never goes live; **wrong** means the badge reads "Treasury data unavailable" | `https://treasury.deel.network/mcp` |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key encrypting stored OAuth tokens at rest (`openssl rand -base64 32`) | No — without it "Connect Treasury" returns 501 | — |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | Previous key, tried only when the current one fails to decrypt | No — rotation grace period only | — |

### Local development only

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `NODE_EXTRA_CA_CERTS` | CA bundle for a corporate TLS-inspecting agent. Read by Node, not by this codebase | No — needed only behind such an agent | see the note at the end of `.env.example` |

### Set by the runtime, not by you

These are listed for completeness. The platform sets them; do not put them in `.env.local`.

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | `development`, `production` or `test`; set by Next.js and the tooling |
| `VERCEL_ENV` | `production`, `preview` or `development`; set by Vercel. Selects the storage partition unless `SANDBOX_STORAGE_ENV` overrides it |
| `NODE_PATH` | Module resolution root; set by `scripts/register-node-path.cjs` at startup |

`TREASURY_MCP_URL` must point at a **publicly resolvable** host. Internal `*.deel`
names resolve only on the corporate network/VPN — `treasury.prod.deel` is
`100.64.0.9`, a CGNAT address — so a cloud runtime fails them with
`getaddrinfo ENOTFOUND`, which the UI reports only as the generic
"Treasury data unavailable" badge.

Running the dev server behind a corporate TLS-inspecting agent additionally needs
`NODE_EXTRA_CA_CERTS` — see the note at the end of `.env.example`. Node keeps its
own CA store and ignores the macOS keychain, so without it MCP calls fail with
`SELF_SIGNED_CERT_IN_CHAIN` even though the same URL loads fine in the browser.

## AI Agent (Workbench + Sandbox)

The Workbench FX desk and the Practice sandbox (`/test`) both have a collapsible
AI Agent panel (right side) that answers questions in plain language, accepts
raw CSV/XLSX data files, and runs the desk's own VaR / Cash Carry / CFaR
engines as tools. Sandbox chats are stored separately from Workbench.

Setup: get a free Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
(no credit card required) and set it in `.env.local`:

```bash
GOOGLE_GENERATIVE_AI_API_KEY=your-key-here
```

Free-tier limits are ~10–15 requests/minute. Google may use free-tier request
data to improve its products — avoid sending confidential data on the free tier.
# TreasuryTutorial-
