---
name: fx-review
description: Review a change in this repository against the project's financial, database, security, TypeScript, environment-variable, Next.js API and testing checklists. Use when asked to "review my change", "review this diff", "check my work", "review before PR", "is this safe to push", or after an implementation is finished. Routes to only the checklists that apply to the files that changed. Read-only — it never edits code.
user-invocable: true
allowed-tools: Bash(git *), Bash(ls *), Bash(cat *), Bash(head *), Bash(tail *), Bash(grep *), Bash(rg *), Bash(find *), Bash(node *), Bash(npx *), Read, Grep, Glob, Agent
---

# FX Review

Review a change against this repository's rules. Report what is wrong. Do not fix it.

This repository holds financial data. A wrong number here is a production incident, not a
cosmetic bug. Review with that in mind.

## Boundaries — these are not negotiable

1. **This review is read-only.** Never edit, stage, or commit code during a review. Print the
   report, then stop and wait for the person to decide. If they ask you to fix something, that
   is a new task — use `fx-implement`.
2. **The review runs in a separate sub-agent.** See "Run the review in a sub-agent" below. Never
   review a diff inline in the same context that wrote it.
3. **Every finding about money, secrets, or the Treasury write boundary is CRITICAL.** Do not
   downgrade these. Do not defer them.

   **Carve-out for pre-existing debt.** This boundary governs money, secrets and the Treasury
   write boundary. Two checklists carve out pre-existing state within it, and each is authoritative
   for its own area: `check-financial.md` section 9 (native float) and `check-database.md`
   section 7 (bare `sync()`). Nothing else may invent a carve-out.

   For float specifically: pre-existing native-float arithmetic that the change did
   not introduce is reported as a note, not as CRITICAL. See `check-financial.md` section 9, which
   is authoritative on where that line falls. This exists because the core model is float
   throughout; without the carve-out every review of a financial file returns a wall of CRITICALs
   the change did not cause, `fx-implement` stops after three rounds, and nothing can ship. A gate
   that blocks everything gets switched off, and then it protects nothing.

   The carve-out covers **pre-existing float arithmetic only**. It does not extend to secrets, the
   Treasury write boundary, financial data leaking into logs, or float arithmetic this change
   introduced. Those stay CRITICAL with no exception.
4. **Stop the review** if the diff touches a forbidden path (see `classify.md`). Report the path
   and stop. Do not review the rest.

## Step 1 — Collect the change

Pick the first command that matches the situation.

Uncommitted work:

```bash
git status --short && git diff --name-only
```

Everything on this branch that is not on `dev`:

```bash
git diff --name-only dev...HEAD
```

A specific commit range:

```bash
git diff --name-only <base>...<head>
```

If the list is empty, say so and stop. There is nothing to review.

## Step 2 — Classify the files

Read `classify.md`. Match every changed file against the path table and the content signals.
Build the list of checklists that apply.

Do not load a checklist that no file matched. Loading everything wastes context and buries the
findings that matter.

## Step 3 — Read only the checklists you need

Read the `check-*.md` files that Step 2 selected, and nothing else.

| Checklist | Covers |
|---|---|
| `check-financial.md` | money arithmetic, rates, audit trail, approval limits, idempotency, data leakage, Treasury write boundary |
| `check-database.md` | Sequelize, migrations, transactions, scoping, indexes, what to store from Treasury |
| `check-security.md` | secrets, encryption, OAuth, cookies, failing closed |
| `check-typescript.md` | types, naming, dead code |
| `check-env-vars.md` | `.env.example`, README table and code kept in sync |
| `check-nextjs-api.md` | App Router, session checks, error shape |
| `check-tests.md` | fixtures, failing tests, hand-verified numbers |

## Step 4 — Run the review in a sub-agent

The agent that wrote a change is bad at finding its own mistakes. A fresh context finds more.

Launch the review with the `Agent` tool:

- `subagent_type`: `general-purpose`
- `model`: `opus` — this is **Opus 5 minimum**. A newer model of the same or a higher class is
  also acceptable. Never review on a smaller model.
- Reasoning effort must be **high or above**.

Give the sub-agent: the diff, the checklists you selected, the anti-patterns section below, and
**"The review brief" section below, copied in full** — that is what tells it what to actually look
for. Tell it to return findings only — no fixes, no patches.

**About reasoning effort.** The `Agent` tool accepts `model` but has no `effort` parameter.
Effort comes from the session setting, or from `Workflow`, whose `agent()` accepts both `model`
and `effort`. Before you launch, check which is available:

- If `Workflow` is available and the user has opted into it, use `agent()` with
  `{model: 'opus', effort: 'high'}`.
- Otherwise use the `Agent` tool with `model: 'opus'` and **tell the person in your report** that
  effort was inherited from the session, so they can raise it if it is set low.

Do not claim you set the effort when you did not.

## The review brief

Copy this into the sub-agent prompt in full. `fx-implement` uses the same brief.

> Cover every area below. **Report on each one by name, including the ones where you found
> nothing.** A silent area is indistinguishable from an unchecked area, and the whole point of this
> review is that the author could not see their own gaps.

**1. Security — nothing here may be skipped or deferred**

- Secrets, tokens, credentials or connection strings appearing in source, a fixture, a comment, a
  log line, an error message, or an API response.
- Encryption at rest: AES-256-GCM, a fresh IV per call, AAD binding the ciphertext to its purpose,
  an envelope version. Never a plain block cipher, never hand-rolled.
- Authentication: the session is checked **first** in every route, via `auth()` from `auth.ts`.
  Identity never comes from the client.
- OAuth: PKCE, a random single-use `state` and `nonce`, short TTL.
- Cookies: `httpOnly`, `Secure`, explicit `SameSite`, and a `path` that **matches between set and
  delete** — a mismatch makes the delete silently do nothing.
- Fail closed. Any auth, decrypt or verification failure denies and logs. Never fall back to
  trusting unverified data.
- Input validation at every boundary — body, query, headers, webhooks. Type, range and length.
- Parameterised queries only. No string-built SQL, no user input inside `sequelize.literal()`.
- Error responses leak no stack traces, internals, connection strings or session identifiers.
- New dependencies: each one is new attack surface. Flag any addition and say why it is needed.

**2. Financial data boundaries — treat a breach as CRITICAL**

- Financial data leaving the process by any route other than an API response to an authenticated,
  authorised caller. Logs, stdout, telemetry, tracing, URL query strings, commit messages and test
  fixtures are all forbidden exits.
- Any call to a **mutating** Treasury MCP tool. We read from Treasury and write only to our own
  database.
- Approval thresholds enforced as a hard stop that books nothing, not as a warning that continues.
- Financial writes are idempotent — a retry must not double-book.

**3. Correctness**

- Does the change do what the task asked, and only that?
- Edge cases this repo actually has: zero exposure, a single-currency portfolio, a restricted
  currency, an empty book, a negative position.
- Null and undefined handling on every value that can be absent — several features here degrade by
  design when a variable or the database is missing.
- Async: unawaited promises, races, and anything that assumes ordering it does not control.

**4. Sign, unit and scale — the errors this codebase actually ships**

These are silent, expensive, and this repository has a recorded history of them. Check explicitly:

- **Sign and direction.** Long versus short, near versus far leg, buy versus sell, payer versus
  receiver. An inverted sign produces a plausible number that is exactly wrong.
- **Units.** FCY versus USD. Per-annum versus per-month versus per-day. Percent versus basis points
  versus decimal fraction. Millions versus units.
- **Scale.** What is the quantity actually scaled against — a flow or a stock? `decisions.md`
  (2026-05-28) records a real bug where a buffer was scaled on the monthly outflow instead of the
  position it was protecting.
- **Rounding placement.** Rounded once at the boundary, never mid-chain.

**5. Logic**

- Does the change contradict a recorded decision or anti-pattern in `decisions.md` or
  `liquidity-book.md`? In several places the *obvious* approach is the one that was rejected.
- A shared function whose name, type, or return meaning changed — were **all** callers checked?
  Name them.
- A function that silently reinterprets its input into something the caller did not mean.
- Inverted conditions, unreachable branches, dead code left behind.

**6. What the change does not do**

- Did it quietly narrow the scope it was asked for?
- Did it leave a case handled in one place and not the parallel one?
- Did it add anything beyond what was asked?

**7. Tests**

- Do the new tests actually exercise the change, or would they pass against the old code too?
- Any `as` cast in a test file — that is how a real gap has already shipped here.
- Fixtures contain fake data only, never a real balance, account identifier or counterparty.

**8. Failure paths**

- What happens when Treasury MCP is unreachable, the database is absent, or a required environment
  variable is unset? This application is designed to degrade rather than crash — confirm the change
  keeps that, and that degradation is visible to the user rather than silent.

**About reasoning effort.** The `Agent` tool accepts `model` but has no `effort` parameter. Effort
comes from the session setting, or from `Workflow`, whose `agent()` accepts both `model` and
`effort`. Before launching:

- If `Workflow` is available and the user has opted into it, use `agent()` with
  `{model: 'opus', effort: 'high'}`.
- Otherwise use `Agent` with `model: 'opus'` and **state in your report** that effort was inherited
  from the session, so the person can raise it if it is set low.

Never claim you set the effort when you did not.

## Step 5 — Report

Group findings by severity. Most severe first.

| Severity | Meaning | Effect |
|---|---|---|
| CRITICAL | money is wrong, a secret leaks, a rule in `CLAUDE.md` is broken, or Treasury data would be modified | must be fixed before push |
| HIGH | a real defect, but contained | fix before push unless the person decides otherwise |
| MEDIUM | correctness risk or a convention broken | fix or record why not |
| LOW | style, clarity, naming | optional |

For each finding give: the file and line, one sentence on what is wrong, one sentence on what
goes wrong because of it, and the rule it breaks with its source file.

A finding without a concrete failure is not a finding. Delete it.

End the report with one of:

- `RESULT: CLEAN — nothing found` — proceed to `fx-pre-push`.
- `RESULT: <n> findings, <m> CRITICAL` — then stop and wait.

## Repository anti-patterns — check these every time

These are decisions already made and written down in `.claude/rules/project/decisions.md` and
`.claude/rules/project/liquidity-book.md`. In each case the *obvious* approach is the wrong one,
so a newcomer breaks them first. Read the source entry before you flag or clear one.

**Liquidity book versus funding swap.** The funding swap must never enter the LIQUIDITY POOL BOOK
on the dashboard. Never put `liquidityPlan[k].opening_cash` in a liquidity-book cell — it already
contains an earlier Swap Near. Never add `swapNear` to `lp_peak_cash`, `cash_after_payins`, or
ladder `opening` / `closing` / `low`. FX hedge *settlement* on the operating path is fine; the
funding swap is not. Source: `liquidity-book.md`.

**Buffer scale.** `computeLayeredBuffer` scales on `|forecasted_cash|` (`cash + payout`), not on
`|payout|`. Payout is a monthly flow; the buffer protects the position, which is a stock. Falling
back to `|payout|` is correct only when `|forecasted_cash| < 0.001`. Source: `decisions.md`,
2026-05-28.

**Swap formula.** Layers off is `swap = -spot_raw`. Layers on is
`swap = MAX(H_final - forecasted_cash, -spot_raw)`. Never put `fwd_raw` in the restructuring term
— the forward already sits at the far tenor and needs no near leg. Using `-(spot + fwd)` sells
when the net is long but the spot is short. Source: `decisions.md`, 2026-05-28.

**VaR basis.** Do not use stock-only exposure for the Risk Metrics hedge target when the Analytics
basis includes a forecast. Do not apply `|E_end| x sigma x sqrt(T)` to a linear buildup. Do not
conflate forecast period `Tf` with VaR tenure `Th`. Source: `decisions.md`, 2026-07-28.

**Post-quantum cryptography.** Do not add a PQC KEM or signature scheme to symmetric, single-party
encryption at rest. There is no asymmetric step in that design, so there is nothing for Shor's
algorithm to break. Source: `decisions.md`, 2026-08-13.

## When the person asks you to fix what you found

Say that the review is read-only, and hand them the next step:

> Found `<n>` items. To fix them, run `fx-implement` — it applies the change and re-reviews.
> To push once they are fixed, run `fx-pre-push`.
