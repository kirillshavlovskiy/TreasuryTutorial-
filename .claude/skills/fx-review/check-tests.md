# Testing checklist

Tests run with vitest: `npm test` (which is `vitest run`). Unit tests sit next to their source
as `*.test.ts`.

---

## 1. Fixtures must satisfy the real type

This is the single most important item in this file.

- [ ] A test fixture satisfies the **real type**. It is not cast past it with `as SomeType`.
- [ ] No `as` type assertion appears in a test to paper over missing required fields.
- [ ] When a fixture is awkward to build by hand, the test **reuses the real production
      constructor or factory** rather than hand-rolling and casting a partial object.

A cast that papers over missing fields hides exactly the bugs types exist to catch. This has already
happened in this repository: a suite passed green on `as Type`-cast fixtures while a real gap sat
underneath it. Treat any `as` inside a `*.test.ts` as CRITICAL until proven harmless.

Source: `CLAUDE.md` → Code Style, Working with AI-Generated Code;
`.claude/rules/project/decisions.md`.

## 2. Fake data only

- [ ] Fixtures contain **fake data**. Never real balances, real account identifiers, real
      counterparty names, or a real position copied out of Treasury or the TMS.
- [ ] Integration tests use sandbox or staging environments, never production data.

Real financial values in a fixture violate `check-financial.md` section 6 — a committed fixture is a
permanent, searchable copy of restricted data.

Source: `.claude/rules/dept/engineering.md`; `.claude/rules/dept/compliance.md`.

## 3. Before "fixing" a failing test

A failing test is a symptom. Changing the assertion to match current behaviour is correct **only**
if that behaviour is actually intended.

- [ ] The change establishes whether the bug is in the **implementation** or in the **test**, and
      says which.
- [ ] Git history or blame was checked for why the assertion said what it said.
- [ ] Everything else depending on the current behaviour was traced before the decision.

If a change updates an expected value without answering this, that is a finding.

Source: `CLAUDE.md` → Working with AI-Generated Code.

## 4. Coverage of the change

- [ ] New business logic has unit tests.
- [ ] Each test name describes behaviour, not implementation: `'returns USD when exposure is zero'`,
      not `'calls getBalance'`.
- [ ] FX edge cases are covered explicitly: **zero exposure**, **single-currency portfolio**, and a
      **restricted currency**.
- [ ] Rate conversion, exposure aggregation and hedge-ratio calculation each have direct coverage.
- [ ] A VAR model change is validated against a known historical scenario.

Source: `.claude/rules/div/standards.md` → Testing requirements;
`.claude/rules/project/engineering.md`.

## 5. One number checked by hand

- [ ] At least one real number the change produces has been verified by hand against an independent
      calculation, and the check is written down.

A green suite proves the code matches the tests. It does not prove the tests were right. This is
also step 8 of `fx-pre-push`, and it cannot be satisfied automatically.

Source: `CLAUDE.md` → Working with AI-Generated Code.

## 6. Test placement

- [ ] Unit tests are co-located with their source: `lib/fx-buffer.ts` → `lib/fx-buffer.test.ts`.
- [ ] Tests are not placed under `.claude/worktrees/` — `vitest.config.mts` excludes that path
      deliberately, because those are separate checkouts and stale copies there would run as if
      they belonged to this tree.

## 7. Do not commit unfinished work — HARD

A skipped test is not a finished change. Neither is a red typecheck.

- [ ] `npx tsc --noEmit` introduces **no new error**. Not "no error in the file I touched" — no new
      error anywhere.
- [ ] No test file is committed whose imports do not resolve. That is not a quarantine, it is a
      broken file, and it makes the typecheck permanently red for everyone who comes after.
- [ ] No test is left `.skip`-ed without a **ticket reference and a named owner** in a comment
      directly above it.
- [ ] A change that cannot pass its own tests is not ready to commit. Fix it, revert it, or hold it
      on the branch — do not land it and leave the failure for the next person.

### Scope: this applies to what YOUR change does

Like `check-financial.md` section 9 and `check-database.md` section 7, split your findings:

- **Introduced by this change** — a new `.skip`, a new unresolvable import, a new `tsc` error.
  HARD, blocks the push.
- **Pre-existing** — four test files under `lib/` already carry `.skip`-ed cases. Report once as a
  note. Do not block an unrelated change on them.

### If a test genuinely must be quarantined

Sometimes a test arrives failing from an earlier change and blocking the deploy is worse. That is a
real situation. It still has a minimum bar:

1. A **ticket** that says what must be decided, and **who decides it**.
2. The typecheck **stays green**.
3. A comment saying **why** it is skipped, **what** would settle it, and a grep tag.
4. Expected values are **not** re-baselined to current behaviour. See section 3.

**Parts 2 and 4 conflict unless you understand what the evidence actually is.** The evidence is the
**scenario and its expected numbers** — not the executable call. So when a symbol the test imports
no longer exists:

- Deleting only the `import` line does **not** work. The skipped bodies still reference the symbol,
  so `TS2724` (no exported member) simply becomes `TS2304` (cannot find name). Verified on
  `lib/cfar-cover.test.ts`, whose skipped bodies at lines 136–153 call all three missing functions.
- Comment out the **whole block** — import and bodies together — leaving the numbers and the
  scenario readable as text. `tsc` goes green and nothing is lost.
- Or, if the rename is known, point the import at the real symbol and keep the case `.skip`-ed with
  the original expected value beside it.

What you must not do is a **partial** cleanup that leaves the typecheck red in a different way.

### The cost this repository is already paying

`lib/cfar-cover.test.ts` and `lib/cash-carry-path.test.ts` carry 12 `.skip`-ed cases and imports
pointing at functions that no longer exist in `lib/fx-buffer.ts`. Parts 3 and 4 were done well —
the note is clear, the tag is `LIQUIDITY-SUITE-QUARANTINE`, and the expected values were
deliberately preserved. Part 1 was **not**: there is no ticket reference in either file and the
owner is only "the FX team". Part 2 was not either: `npx tsc --noEmit` has been red on `dev` ever
since.

The result is that every push has to reason about whether those errors are "the expected ones",
and `fx-pre-push` step 3 has to carry a baseline. Anyone reading quickly can wave through a real
new error in those two files. That cost was created in one commit and is paid on every commit
after it.

Do not add to it. This checklist item exists so the next quarantine keeps the typecheck green.

Source: `CLAUDE.md` → Working with AI-Generated Code ("type errors are part of 'done', not noise").
