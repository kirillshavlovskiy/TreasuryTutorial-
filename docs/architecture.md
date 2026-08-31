# Treasury OAuth (Okta) Integration — Architecture

> Companion to `.claude/rules/project/decisions.md`. Covers how Nexus connects
> to Treasury's Finance MCP server to pull live Notional Pool cash balances
> into the Workspace simulator, without touching the existing Google sign-in
> (`auth.ts`) or any of Kirill's FX engine code (`lib/dashboard-model.ts`,
> `lib/fx-buffer.ts`, `lib/test-mode/*`).

## Why a second auth flow

Nexus already gates `/workspace` behind NextAuth + Google (`auth.ts`) — that
answers "is this a Nexus user?". Getting *Treasury* data additionally
requires answering "does Treasury's own RBAC let this specific person see
this data?", which only Treasury can answer, via the same Okta-backed
Finance MCP OAuth flow already running in production for the MCP server
(Claude, Cursor, etc.). The two are independent and stack: a user signs into
Nexus with Google, then optionally "connects Treasury" from `/workspace` —
a second, additive OAuth round trip against a separate Okta OIDC client
registered under the **same** Okta Authorization Server ("Treasury MCP") the
Finance MCP server already verifies tokens against. Treasury requires zero
code changes: `verifyFinanceMcpBearerToken` checks token signature/issuer/
audience, never `client_id`, so a second registered client is
indistinguishable from the MCP one.

## 1. OAuth sequence

```mermaid
sequenceDiagram
    actor U as User (browser)
    participant N as Nexus (Next.js)
    participant DB as Postgres
    participant O as Okta ("Treasury MCP" AS)
    participant T as Treasury Finance MCP

    Note over U,N: Already signed in via Google (auth.ts) — unrelated to this flow
    U->>N: GET /api/treasury/oauth/connect
    N->>N: require NextAuth session (else 401)
    N->>N: generate PKCE verifier + state + nonce
    N-->>U: Set-Cookie treasury_oauth_state (httpOnly, AES-256-GCM, 10 min)<br/>302 -> Okta /v1/authorize
    U->>O: authorize (code_challenge, state, nonce)
    O-->>U: 302 -> /api/treasury/oauth/callback?code&state
    U->>N: GET /api/treasury/oauth/callback
    N->>N: verify state cookie matches, email in cookie matches session email
    N->>O: POST /v1/token (code, code_verifier, client_secret)
    O-->>N: access_token, refresh_token, id_token
    N->>N: verify id_token (JWKS, iss, aud, nonce) -> email must equal session email
    N->>DB: upsert encrypted access/refresh token, keyed by email
    N-->>U: 302 -> /workspace?treasury=connected

    Note over U,N: Later, any /workspace request
    U->>N: GET /workspace
    N->>DB: load token row for email (row lock)
    alt token fresh
        N->>N: use stored access_token
    else expiring/expired
        N->>O: POST /v1/token (grant_type=refresh_token)
        O-->>N: new access/refresh token
        N->>DB: persist rotated tokens
    end
    N->>T: POST /mcp  Authorization: Bearer <access_token>
    T->>T: verify JWT (JWKS/iss/aud) -> resolve user -> ResourcePermissions
    T-->>N: investment_revenue_summary rows
    N-->>U: Workspace with live NP cash merged in
```

Tokens never reach the browser — only an opaque NextAuth session cookie
does. The Treasury access/refresh token pair lives exclusively in Postgres,
AES-256-GCM encrypted (`lib/treasury/crypto.ts`). The state cookie is
encrypted under the same `TOKEN_ENCRYPTION_KEY` but with a distinct AAD tag
(`AAD_OAUTH_STATE_COOKIE` vs `AAD_TREASURY_TOKEN`), so a leaked cookie value
can't be decrypted as if it were a stored token, or vice versa. All redirect
URIs are built from `AUTH_URL`, not the request's `Host` header, to avoid an
open redirect off these authenticated endpoints — required in production
(`treasuryCanonicalOrigin` throws rather than falling back to the
Host-derived origin when `NODE_ENV=production` and `AUTH_URL` is unset),
optional in local dev. The row lock in the diagram above is only taken when
a refresh is actually due — the common case (token nowhere near expiry)
reads without a lock or transaction at all. A refresh failure only drops
the stored link when Okta explicitly rejects it (`invalid_grant`); a
timeout or 5xx leaves the link intact and surfaces as a transient error.

## 2. Components and trust boundaries

```mermaid
flowchart TB
    subgraph Browser["Browser (untrusted)"]
        UI["/workspace UI"]
    end

    subgraph Nexus["Nexus server (Next.js, trusted)"]
        direction TB
        Auth["auth.ts — NextAuth + Google\n(untouched)"]
        subgraph TreasuryLayer["lib/treasury/*  (new, additive)"]
            OktaClient["okta-client.ts\nPKCE, token exchange, JWKS verify"]
            TokenStore["token-store.ts\nencrypt/decrypt, refresh-on-expiry,\nrow-lock against refresh races"]
            McpClient["mcp-client.ts\nStreamable HTTP client, zod-validated"]
            Snapshot["snapshot.ts\ngetTreasurySnapshotForUser()\nmaps MCP rows -> RowState overlay"]
        end
        Routes["app/api/treasury/oauth/*\nconnect / callback / disconnect"]
        WS["app/workspace/page.tsx\n+ WorkspaceApp.tsx"]
    end

    subgraph PG["Postgres (existing, lib/db/sequelize.ts)"]
        TokTable["treasury_oauth_tokens\n(AES-256-GCM ciphertext columns)"]
    end

    subgraph OktaBox["Okta — 'Treasury MCP' Authorization Server"]
        OktaApp["Nexus OIDC client\n(separate client_id, same issuer/audience\nas the Finance MCP client)"]
    end

    subgraph TreasuryBox["Treasury (unchanged)"]
        MCP["POST /mcp\nverifyFinanceMcpBearerToken\n-> User + ResourcePermissions"]
    end

    UI -- "session cookie only" --> WS
    WS --> Auth
    WS --> Routes
    Routes --> OktaClient
    OktaClient <-- "authorize / token" --> OktaApp
    OktaClient --> TokenStore
    TokenStore <--> TokTable
    WS --> Snapshot
    Snapshot --> TokenStore
    Snapshot --> McpClient
    McpClient -- "Bearer access_token" --> MCP
```

No change to `helm/`, `.github/`, `argocd/`, `values.yaml`, or `Dockerfile` —
new secrets (`OKTA_ISSUER`, `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET`,
`TREASURY_MCP_URL`, `TOKEN_ENCRYPTION_KEY`) flow in through the existing
AWS Secrets Manager entry `fx-test-project` → `ExternalSecret` → `envFrom`
wiring, same path Google's `AUTH_GOOGLE_*` already uses.

## 3. Data flow — MCP tool → `RowState` / `usdCash` field

```mermaid
flowchart LR
    Tool["investment_revenue_summary\n(provider: jpmorgan + citi,\n7-day lookback)"] -->|"uppercase currency,\nsum(balance) per currency\nat each currency's latest\nrevenueDate — Decimal.js"| Agg["aggregateNpCashByCurrency()\n-> cashByCurrency, asOfRevenueDate"]
    Agg -->|"/ 1e6, roundMoney(8dp)"| Overlay["cash: number (M FCY)\nincl. a USD entry"]
    Static["INITIAL_ROWS (lib/fx-buffer.ts)\n+ usdCash default 303.9\n(lib/treasury/snapshot.ts, unchanged)"] -->|"clone"| Row["RowState / usdCash"]
    Overlay -->|"override cash / usdCash,\ncurrency present in live fetch"| Row
    Row --> Simulator["Simulator.tsx\ninitialRows / initialUsdCash prop\n(same seam Task01App uses)"]
```

Empty or unparseable results are **not** reported as `'live'` — if the tool
returns zero usable rows (feed outage, long weekend beyond the lookback
window), the snapshot falls back to the static book with `status: 'error'`
rather than a truthful-sounding "Treasury live · 0 ccy". `asOf` is the
**oldest** of the overlaid currencies' own latest `revenueDate` — a
deliberately conservative "as of", not the fetch's wall-clock time and not
the freshest date seen. Reporting the newest would let one fresh currency
(e.g. EUR, updated today) hide a laggard (e.g. RSD, last reported 6 days
ago but still inside the lookback window) behind a same-day timestamp; the
oldest-per-currency choice means `asOf` never overstates how fresh the
book actually is.

**Deliberately out of scope this iteration** — verified live against the
connected Treasury MCP, not assumed:

- `spot` / `fwd` (net FX book position): `fx_pl_report` returns cumulative
  P&L and trade-volume figures (`totalAmount` in the billions), not a net
  position — confirmed by a direct call, not a guess from the docs.
- `nonNpCash` (local books outside the NP): `check_all_rails` returns every
  operational account (`Pay In - Deel Inc`, `Pay Out - EOR`, `Client Money
  GP - PYG`, `Corporate Account`, `Investment - Short/Long term`, ...) with
  no field distinguishing "local funding cash" from the rest — summing it
  would silently produce a wrong number in a book this sensitive.
- `CURRENCY_PARAMS` (rates, spot FX): untouched by design — 11 golden-number
  test files in `lib/` assert against the current hardcoded JPM NP figures.

These fields keep their existing static values; the Workspace badge shows
`status: 'live'` with the count of currencies actually overlaid (including
whether the USD leg is live), never a blanket "connected" claim.
