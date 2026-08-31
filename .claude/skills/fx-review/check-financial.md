# Financial checklist

This repository processes balances, rates, hedges and exposures. Every item here has cost a real
incident somewhere. Treat a failure as CRITICAL unless the item says otherwise.

Source of each rule is named at the end of its section.

---

## 1. Arithmetic

- [ ] No native floating-point arithmetic on money or FX rates. Any calculation that aggregates,
      converts or compares a monetary amount uses `Decimal.js`.
- [ ] The calculation stays in `Decimal` end to end. Converting to a JS number in the middle and
      back defeats the purpose — check the whole path, not the first line.
- [ ] No `parseFloat`, `Number()`, `+`, `*` applied directly to an amount, balance, notional or rate.
- [ ] Rounding: amounts to **2 decimal places**; FX rates to **4 decimal places**, or 6–8 when the
      source data actually provides that precision. Never round in the middle of a chain — round
      once, at the boundary where the number is presented or stored.

A float rounding error in a hedging calculation is a production incident, not a cosmetic bug.

Source: `CLAUDE.md` → Financial Data Handling; `.claude/rules/div/standards.md`.

## 2. Currency and time

- [ ] Every rate value carries an explicit currency code — ISO 4217, **uppercase**, as a string.
      Never a numeric currency code.
- [ ] Every rate lookup names an explicit timestamp and source. There is no implicit "current rate".
- [ ] A currency code variable is named with the `Currency` suffix (`baseCurrency`,
      `settlementCurrency`). An amount carries `Amount` or `Notional`.

Source: `CLAUDE.md`; `.claude/rules/div/standards.md`.

## 3. Audit trail — log the decision, not just the result

- [ ] Anything that sizes or executes a financial position writes an audit entry that lets someone
      reconstruct **why the number was what it was** — not only what it was.
- [ ] The entry records **who** acted (user identity and role), **what** happened (transaction type,
      accounts), **when** (timestamp), and **why** (the inputs and the rule that produced the size).
- [ ] Audit entries are append-only. Nothing updates or deletes an audit row after the fact.
- [ ] Retention is **7 years**.

Source: `CLAUDE.md` → Financial Data Handling; `.claude/rules/dept/compliance.md` (7-year retention).
This matches standard practice for financial-reporting controls, where auditors expect an
immutable, timestamped record tied to a specific user identity.

## 4. Approval thresholds are hard stops in code

A limit that exists only in a policy document is not enforced. If a code path can exceed a
configured threshold, it must **stop**, not warn.

- [ ] FX position size, USD equivalent: above **$50M** needs Director of Finance; above **$100M**
      needs CFO; above **$250M** needs CEO.
- [ ] Stressed P&L VAR at 95% confidence: above **$5M** needs Director of Finance; above **$10M**
      needs CFO; above **$20M** needs CEO.
- [ ] Automated hedges run without manual approval only up to **$10M** notional. Above that needs
      FX Lead and CFO. Options always need FX Lead sign-off regardless of notional.
- [ ] A breach returns an error and books nothing. It does not log a warning and continue.

Source: `.claude/rules/div/fx-hedging-policy.md` → Approval Thresholds;
`.claude/rules/div/policy.md` → FX trade limits.

## 5. Idempotency

Financial writes — trade execution, hedge booking, token issuance — must be idempotent. A retried
request must not double-book.

- [ ] The write accepts an idempotency key. The caller generates it (a UUID) and sends it with the
      request.
- [ ] The server stores the key together with a hash of the request payload and the response it
      returned.
- [ ] Same key, same payload → return the stored response. Do no work twice.
- [ ] Same key, **different** payload → reject with `409 Conflict`. This catches a client bug that
      would otherwise silently overwrite.
- [ ] Concurrent requests with the same key are serialised — a lock or a database transaction, not
      a read-then-write race.
- [ ] Keys are retained for about **24 hours**, which covers a normal retry window.

Retry logic and idempotency keys are not alternatives. Retries live on the client, keys protect the
server, and safe money movement needs both.

Source: `CLAUDE.md` → Financial Data Handling; standard payment-API practice.

## 6. Financial data must not leak — HARD

Payment data is classified `RESTRICTED`. Treat balances, amounts, rates tied to a position, account
identifiers and counterparty data the same way.

- [ ] **Nothing financial is logged.** No amounts, balances, position-linked rates, account
      identifiers, transaction identifiers or counterparty data — not in `console.log`, not in a
      logger call, not in an error message, not in a stack trace annotation.
- [ ] Financial data leaves the process **only as an API response**, to a caller that is both
      authenticated and authorised. That is the only permitted exit.
- [ ] Not in stdout or stderr. Not in third-party telemetry, tracing or error reporting. Not in a
      URL path or query string. Not in a commit message. Not in a test fixture.
- [ ] If a value must reach an external sink for an operational reason, it is masked or omitted
      **before** it is sent, not filtered at the far end.
- [ ] Account identifiers, balances and counterparty data are encrypted where they are persisted.

Any of these failing is CRITICAL.

Source: `.claude/rules/dept/compliance.md` → Data classification; `CLAUDE.md` → Security and
Financial Data Handling. Masking before forwarding is standard PCI DSS logging practice.

## 7. Treasury write boundary — HARD

Treasury is the system of record. This application reads from it and never changes it.

- [ ] We **read** from Treasury.
- [ ] We **write and change data only in our own service's database.**
- [ ] **We never modify data in Treasury. There is no exception and no override.**

Any call to a mutating Treasury MCP tool from this codebase is CRITICAL. Non-exhaustive list of
tools that write and are therefore forbidden here:

```
ap_create_vendor            ap_update_vendor
close_financial_account     create_purchase_order
delete_account_document     edit_financial_account
edit_reconciliation         enrich_invoice
ns_create_vendor_bill       ns_update_vendor_bill
po_attach_vendor_agreement  reconcile_record
set_financial_account_pocs  tag_reconciliations
tms_create_financial_account tms_upload_account_document
upload_bank_statement
```

Read-only tools — `gl_*`, `sf_*`, `fx_*`, `search_*`, `list_*`, `get_*`, `check_*`, `aa_*`, and the
`*_lookup` family — are fine.

If a tool name is not on either list, treat the verb in its name as the answer: `create`, `update`,
`edit`, `delete`, `close`, `upload`, `set`, `tag`, `reconcile` and `enrich` all write. When still
unsure, flag it and ask rather than assume.

Source: `CLAUDE.md` → Financial Data Handling; `.claude/rules/dept/department.md` → all financial
data access goes through the MCP layer.

## 8. Hand-verify one number

- [ ] At least one real number produced by this change has been checked by hand against an
      independent calculation, and the check is recorded — in the PR description, the ticket, or
      `decisions.md`.

A green test suite proves the code matches the tests. It does not prove the tests were right. This
repository has already shipped a hidden gap that way, on fixtures cast past their real type.

Source: `CLAUDE.md` → Working with AI-Generated Code.

## 9. Known state of this repository — read before reporting section 1

Section 1 requires `Decimal.js` for money arithmetic. **This repository does not currently meet
that rule.** Of 125 non-test `.ts`/`.tsx` files under `lib/` and `components/`, exactly **one**
imports `decimal.js` — `lib/treasury/snapshot.ts`. The core model — `lib/fx-buffer.ts` and the
calculators around it — is native floating point throughout:

Check it yourself rather than trusting this paragraph:

```bash
git grep -l "from 'decimal.js'" -- lib components app
```

Do not grep for the bare word `Decimal`: it also matches the chart-axis props `xDecimals` and
`yDecimals` in `components/BufferOptimizer.tsx`, `LineChart.tsx`, `UnifiedSimulator.tsx` and
`test-mode/PortfolioCarryVarFrontierPlot.tsx`, none of which use Decimal.js. An earlier version of
this section made exactly that mistake and overstated adoption fourfold.

```ts
// lib/fx-buffer.ts
return Math.max(cash_floor, Math.abs(netPosition) * vf * mult);
```

This is pre-existing debt, not something any current change introduced. Report it as such.

**Split your section 1 findings into two lists:**

- **Introduced by this change** — new native-float arithmetic on money. CRITICAL, blocks the push.
- **Pre-existing** — float arithmetic the change merely touched, moved, or sits next to. Report it
  once, as a note, and do **not** mark it CRITICAL.

Why this matters: `fx-review/SKILL.md` forbids downgrading a CRITICAL, and `fx-implement` hard-stops
when a CRITICAL survives three review rounds. Without this split, the first review of any
`lib/fx-*.ts` change returns a wall of pre-existing CRITICALs, the loop stops after round three, and
**no change to the financial model can be landed through the documented workflow**. A gate that
blocks everything gets switched off, and then it protects nothing.

Migrating the model to `Decimal.js` is real work with real risk to the numbers. It needs its own
ticket, its own hand-verification of every affected figure, and FX lead sign-off — not a drive-by
fix inside an unrelated change.
