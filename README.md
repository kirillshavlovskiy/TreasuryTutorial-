# test-treasury-project

TODO: add project description

## Setup

See [.claude/framework-setup.md](.claude/framework-setup.md) for full setup instructions.

## Development

```bash
npm install
npm run dev
```

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
| `AUTH_SECRET` | HMAC signing secret for this app's session cookie (`openssl rand -base64 33`) | **Yes** — sign-in cannot work without it | — |
| `AUTH_URL` | Canonical origin for building the OAuth `redirect_uri` | **Yes in production** — the app refuses to derive it from the `Host` header and throws | `https://ssigma.dp.com` |
| `NEXTAUTH_URL` | Legacy override for this app's callback URL (`${NEXTAUTH_URL}/api/auth/callback`) | No — the request origin is used when omitted | `http://localhost:3000` |
| `GOOGLE_CLIENT_ID` | Shared Google OAuth client | **Yes** — sign-in fails without it | — |
| `GOOGLE_OAUTH_PROJECT_ID` | This project's platform routing ID on the login proxy | **Yes** — sign-in fails without it | — |
| `GOOGLE_REDIRECT_URI` | Platform proxy URL Google redirects to after sign-in | **Yes** — same value locally and in production | `https://login.dp.com/api/gcp-oauth/callback` |

### PostgreSQL (sandbox and desk snapshots)

The connection string is taken from the first of the four URL variables that is set, in that
order. The Neon/Vercel Marketplace integration injects the `ssigma_*` names. Set only one.

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `DATABASE_URL` | Postgres connection string, first choice | No — without any URL, sandbox and desk state persist in the browser only | `postgres://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require` |
| `ssigma_DATABASE_URL` | Same, second choice; injected by the Marketplace integration | No — same degradation as above | — |
| `POSTGRES_URL` | Same, third choice | No — same degradation as above | — |
| `ssigma_POSTGRES_URL` | Same, fourth choice | No — same degradation as above | — |
| `DATABASE_SSL` | Force SSL on the connection; Neon hosts and `sslmode=require` enable it anyway | No — inferred from the URL | `true` |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | Allow a self-signed certificate on the database connection | No — defaults to rejecting | `false` |
| `DATABASE_IP_FAMILY` | IP family for the connection: `6` selects IPv6, anything else IPv4 | No — defaults to IPv4 | `4` |
| `SANDBOX_STORAGE_ENV` | Force the storage partition instead of deriving it from `VERCEL_ENV` | No — `production` on Vercel production, `uat` elsewhere | `uat` |

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
