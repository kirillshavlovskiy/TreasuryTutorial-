# Next.js and API checklist

This is a Next.js App Router application. The Pages Router is not used and must not be added.

---

## 1. Routing and components

- [ ] New routes live under `app/`. No `pages/` directory is created.
- [ ] Server components by default. `"use client"` appears only where interactivity genuinely
      requires it.
- [ ] Data is not fetched in a client component when it could be fetched on the server.

Source: `CLAUDE.md` → Next.js Patterns.

## 2. API routes

- [ ] API routes live under `app/api/`.
- [ ] **The session is validated first**, before any other work in the handler. Use
      `getServerSession` / `auth()`, exported from `auth.ts`.
- [ ] The handler never trusts a user id, organisation id, or role supplied by the client. Identity
      comes from the session only.
- [ ] Every external call — Treasury MCP, the database, any third-party service — is wrapped in
      `try`/`catch`.
- [ ] Responses are structured JSON with an appropriate HTTP status code.
- [ ] Partial failures are surfaced in the response, not masked. If three of four rates loaded, the
      response says which one did not.
- [ ] Errors are logged with enough context to debug, and **without** sensitive values — see
      `check-financial.md` section 6 and `check-security.md`.

Source: `CLAUDE.md` → Next.js Patterns, Error Handling.

## 3. Financial data crossing the boundary

- [ ] An API response carrying financial data goes only to a caller that is authenticated **and**
      authorised for that data.
- [ ] No financial value appears in a URL path or query string. Account identifiers, balances and
      counterparty data especially.
- [ ] No financial value is logged on the way in or out.

The API response is the only permitted exit for financial data. See `check-financial.md` section 6.

## 4. Client components

- [ ] A component that displays money formats it from a `Decimal` or a pre-formatted string. It does
      not perform arithmetic on a JS number to produce the displayed value.
- [ ] Rounding for display happens once, at the display boundary, at the precision
      `check-financial.md` section 1 requires.
