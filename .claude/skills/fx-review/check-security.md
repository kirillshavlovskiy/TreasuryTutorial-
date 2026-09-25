# Security checklist

Applies to anything touching secrets, encryption, authentication, sessions, cookies, or an API
boundary that accepts external input.

---

## 1. Secrets

- [ ] No secret, token, credential or connection string is hardcoded. Everything comes from an
      environment variable.
- [ ] No secret is committed — not in a fixture, not in a comment, not in a test, not in
      `.env.example` (which holds names and generation commands, never real values).
- [ ] No secret appears in a log line, an error message, or an API response.

Source: `CLAUDE.md` → Security; `.claude/rules/dept/compliance.md`.

## 2. Encryption at rest

Any secret or credential that outlives the request that issued it — OAuth tokens, API keys, session
material — is encrypted at rest.

- [ ] The cipher is **AES-256-GCM**. An AEAD cipher, not a plain block cipher, and never hand-rolled.
- [ ] A **fresh random IV per encryption call**. An IV is never reused under the same key.
- [ ] **Associated Data (AAD)** binds the ciphertext to its purpose, so a ciphertext stolen from one
      context cannot be replayed as valid in another. See `lib/treasury/crypto.ts` for the pattern.
- [ ] The ciphertext carries an **envelope version** (`v1:` prefix here) so the algorithm can change
      later without a data migration.
- [ ] Decryption supports a **previous key** (`TOKEN_ENCRYPTION_KEY_PREVIOUS`) so a key rotation is
      an operational action, not a migration. Encryption always uses the current key only —
      rotation is a read-side fallback, never a write-side choice.
- [ ] No plaintext secret in a database row, ever. The threat model is "the database, a backup, a
      replica, or Redis leaks on its own", which already bypasses the application's access control.

**Do not add post-quantum cryptography here.** This is symmetric, single-party encryption — the
server encrypts its own data with a key it already holds. There is no key exchange and no signature,
so there is no asymmetric step for Shor's algorithm to attack. Grover's algorithm gives only a
quadratic speedup against a symmetric cipher, so AES-256 keeps roughly 128-bit security against a
quantum adversary, which is the margin NIST's own post-quantum guidance targets. Adding a KEM such
as ML-KEM would add real complexity against a threat that is not present. If a specific design does
appear to need PQC, ask before implementing it.

Source: `CLAUDE.md` → Security → Encryption at rest; `.claude/rules/project/decisions.md`,
2026-08-13.

## 3. OAuth and sessions

- [ ] Server-to-server OAuth uses Authorization Code with PKCE for anything beyond a simple login.
- [ ] A random `state` (CSRF protection) and `nonce` (id_token replay protection) per attempt. Both
      single-use, both with a short TTL.
- [ ] The session returned by `getServerSession` / `auth()` (exported from `auth.ts`) is
      checked **first** in every API route.
- [ ] Never trust a user id, organisation id or role passed from the client.

Source: `CLAUDE.md` → Security → Auth & sessions, Next.js Patterns.

## 4. Cookies

- [ ] Cookies carrying session or OAuth-flow state set `httpOnly`, `Secure`, an explicit `SameSite`,
      and an explicit `path`.
- [ ] The `path` **matches between `set` and `delete`**. A cookie's identity is name plus domain plus
      path (RFC 6265), so a mismatched path means the delete silently does nothing and the session
      survives when it should not.

Source: `CLAUDE.md` → Security → Auth & sessions.

## 5. Fail closed

- [ ] On any authentication, decryption or verification failure: deny and log the failure.
- [ ] Never fall back to trusting unverified data because verification was inconvenient or because
      a key was missing.
- [ ] A missing configuration value degrades the feature explicitly (a `501`, a disabled button) —
      it never silently downgrades a security control.

Source: `CLAUDE.md` → Security.

## 6. Input validation

- [ ] All external input is validated at the API boundary — request bodies, webhooks, query
      parameters, headers. `zod` is available and already used in this repository.
- [ ] Validation checks type, range and length, not just presence.
- [ ] User-supplied data never reaches `exec`, a dynamic import, an OS command, or a raw SQL string.

Source: `CLAUDE.md` → Security.

## 7. Error responses

- [ ] Errors return structured JSON with an appropriate status code.
- [ ] Error messages do not leak stack traces, system internals, connection strings or session
      identifiers.
- [ ] `401` for missing or invalid credentials; `403` for authenticated but not authorised.
- [ ] Errors are not swallowed. They are logged with enough context to debug — **without** the
      sensitive values themselves.

Source: `CLAUDE.md` → Error Handling.

## 8. Rate limiting and audit logging

- [ ] Security-sensitive endpoints — authentication, token refresh, disconnect, anything that moves
      money — are audit-logged with the outcome and no token material.
- [ ] Rate limiting is present, **or** its absence is a recorded decision rather than an oversight.

Note the current state: `app/api/treasury/oauth/{connect,callback,disconnect}/route.ts` log a
structured success line but are deliberately **not** rate-limited, because this project has no
Redis and every deployment target can run multiple instances, so an in-memory counter would only
limit requests reaching the same pod. That is recorded in `decisions.md`, 2026-08-13. If a change
adds a new security-sensitive endpoint, it either gets rate limiting or gets an entry in
`decisions.md` explaining why not. Do not add an in-memory limiter to tick this box — in a
multi-instance deployment it does not bound abuse and creates false confidence.

Source: `CLAUDE.md` → Security; `.claude/rules/project/decisions.md`, 2026-08-13.

## 9. Dependencies

- [ ] No new dependency beyond what the task needed. Every library is new attack surface and new
      audit burden.
- [ ] A new dependency does not conflict with the fixed stack (Next.js, PostgreSQL, Sequelize,
      `ioredis`/`bullmq` if Redis is used, TypeScript strict).
- [ ] If a scanner reports a finding with no fix available, that is a decision to record in
      `decisions.md`, not a warning to ignore.

Source: `CLAUDE.md` → Security, Tech Stack.
