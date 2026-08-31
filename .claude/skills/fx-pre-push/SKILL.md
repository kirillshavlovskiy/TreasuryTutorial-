---
name: fx-pre-push
description: Blocking gate that must pass before anything leaves this machine. Use when asked to "push", "create a PR", "open a pull request", "am I ready to push", "self-review before push", "check before I commit", or when an implementation is finished and about to be shared. Runs types, tests, lint, environment-variable drift, secret and financial-data scan, branch and commit checks, and requires one financial number verified by hand. It does not push — it produces a verdict and the command for you to run.
user-invocable: true
allowed-tools: Bash(git *), Bash(npm *), Bash(npx *), Bash(node *), Bash(cd *), Bash(ls *), Bash(cat *), Bash(head *), Bash(tail *), Bash(wc *), Bash(grep *), Bash(rg *), Bash(find *), Read, Grep, Glob, AskUserQuestion
---

# FX Pre-Push Gate

Ten checks. Run them **in order**. **Stop at the first failure** and report it. Do not run the
remaining checks, and do not push.

## Why this skill cannot push for you

`.claude/settings.json` denies `Bash(git push*)`. That is deliberate. This gate produces a verdict
and hands you the exact command; a person runs it. The gate is blocking by construction, not by
agreement.

## Before you start

Confirm there is something to check:

```bash
git status --short && git branch --show-current && git log --oneline dev..HEAD
```

Three outcomes:

| What you see | Do this |
|---|---|
| commits listed, working tree clean | run the gate |
| **uncommitted changes** | **STOP.** Commit them first — see below. Do not run the gate |
| no commits and a clean tree | nothing to push. Say so and stop |

**Why an uncommitted tree stops the gate.** Step 9 reads `git log dev..HEAD`. With no commit that
returns nothing, every check in it passes because there is nothing to fail, the gate prints
`READY TO PUSH`, and the push sends nothing. A green report on an empty push is worse than no
report.

To commit, run `fx-implement` step 7 — it knows what changed and why. If you are running this gate
standalone on someone else's work, commit it yourself with a Conventional Commits message
(`<type>(<scope>): <summary>`, 72 characters or fewer, no full stop) and check `git status --short`
first so nothing unrelated rides along.

---

## Step 1 — Branch is not protected

```bash
git branch --show-current
```

FAIL if the branch is `dev`, `main`, or `master`.

> FAILED step 1. You are on `<branch>`, which is protected. Create a feature branch first:
> `git switch -c fix/<short-description>` — then run this gate again.

Branch naming: `feature/<ticket-id>-<description>`, `fix/<ticket-id>-<description>`,
`chore/...`, `docs/...`.

Source: `CLAUDE.md` → Git Workflow; `.claude/rules/div/policy.md`.

## Step 2 — No protected path in the diff

```bash
git diff --name-only dev...HEAD && git diff --name-only && git diff --cached --name-only
```

FAIL if any path matches `helm/`, `argocd/`, `.github/`, `Dockerfile`, `values.yaml`,
`.claude/rules/dept/`, or `.claude/rules/div/`. Match on the path **suffix**, so a worktree copy
counts too.

`.claude/rules/project/` is allowed.

> FAILED step 2. `<path>` is platform-managed or sync-managed and must not change. Revert it:
> `git checkout -- <path>` — then run this gate again.

## Step 3 — Types

```bash
npx tsc --noEmit
```

There is **no `typecheck` npm script** in this repository, so call `tsc` directly. `tsconfig.json`
already sets `noEmit: true`.

FAIL on any error. A type error in test code is not noise — it is usually a real bug in the fixture
or in the function under test. Find out which before suppressing it.

**Known pre-existing failures.** Four errors are already on `dev` and are not yours:

Verbatim, so you can compare literally — no ellipsis, no re-wrapping:

```
lib/cash-carry-path.test.ts(14,3): error TS2724: '"@/lib/fx-buffer"' has no exported member named 'fundingSwapPathPointsUsdM'. Did you mean 'fundingSwapCipPointsUsdYr'?
lib/cfar-cover.test.ts(16,3): error TS2724: '"@/lib/fx-buffer"' has no exported member named 'fundingSwapFcyOnUsdYr'. Did you mean 'fundingSwapCarryUsdYr'?
lib/cfar-cover.test.ts(17,3): error TS2724: '"@/lib/fx-buffer"' has no exported member named 'fundingSwapPathFcyOnUsdM'. Did you mean 'fundingSwapPathCarryUsdM'?
lib/cfar-cover.test.ts(18,3): error TS2724: '"@/lib/fx-buffer"' has no exported member named 'fundingSwapCashLegUsdYr'. Did you mean 'fundingSwapCashDeltaUsdYr'?
```

Both files are tagged `LIQUIDITY-SUITE-QUARANTINE`: their cases are `it.skip`-ed on purpose and
their assertions were deliberately **not** re-baselined, so the original expected values survive
for whoever adjudicates them with the FX team. The imports point at functions that no longer exist,
which is what `tsc` is reporting.

Compare **exactly**, not by file name. Run:

```bash
npx tsc --noEmit 2>&1 | tee /dev/stderr | wc -l
```

The count must be **exactly 4**, and each line must be one of the four above.

| Count | Meaning |
|---|---|
| exactly 4, matching the list | `PASS (4 pre-existing quarantine errors)` — continue |
| more than 4 | the extra errors are **yours**. FAIL. Fix them |
| fewer than 4, or a different message | someone changed those files. FAIL — the baseline above is stale and must be updated in this skill as part of that change |

Do not excuse an error merely because it sits in one of those two files. A real new error there
looks exactly like the old ones to a fast reader, which is why the check is on the exact set and
not on the path.

Do not do a **partial** cleanup here. Deleting only the `import` lines turns `TS2724` into
`TS2304`, because the skipped bodies still call those functions — the typecheck stays red, just
differently. And do not re-baseline the assertions: the expected values are the evidence.
`check-tests.md` section 7 describes the cleanup that actually works (comment out the whole block,
keeping the numbers readable). Whether to do it at all is the FX team's call, not yours.

**This baseline should shrink to zero.** It exists only because a past change landed a red
typecheck. `check-tests.md` section 7 now forbids adding to it. When the quarantine is resolved,
delete this whole block and let step 3 be a plain "zero errors".

Source: `CLAUDE.md` → Code Style; the quarantine note at the top of `lib/cfar-cover.test.ts`.

## Step 4 — Tests

```bash
npm test
```

FAIL on any failing test.

Do not "fix" a failing test by editing its expected value until you have decided whether the bug is
in the implementation or the test. See `fx-review/check-tests.md` section 3.

## Step 5 — Lint

```bash
npm run lint
```

FAIL on any error. Warnings are reported but do not block.

**Known false failure inside a git worktree.** If you are working in a worktree under
`.claude/worktrees/`, ESLint walks up the directory tree, finds the parent repository's
`.eslintrc.json`, and exits 1 with:

```
Plugin "@next/next" was conflicted between ".eslintrc.json" and "../../../.eslintrc.json"
```

That is a config-resolution artifact of the worktree sitting inside the parent checkout — not a
problem with your change. Confirm it by running the same command in the main checkout:

```bash
cd /path/to/fx-test-project && npm run lint
```

If the main checkout is clean, record step 5 as `PASS (config conflict in worktree; clean in main
checkout)` and continue. If it reports real errors, they are real — fix them.

## Step 6 — Environment variable drift

```bash
node .claude/skills/fx-review/scripts/env-drift.mjs
```

Read the last line of the output before anything else:

| Output | Meaning |
|---|---|
| `RESULT: IN SYNC` | PASS |
| `RESULT: DRIFT FOUND` | see below |
| `RESULT: SCAN FAILED` | **FAIL, always** |

`SCAN FAILED` (exit `1`) is **not** `IN SYNC`. It means no `process.env` reference was found at
all, which cannot be true for this application — git is missing, this is not a repository, or a
pathspec stopped matching. Do not read the empty drift lists as "no drift". Fix the scan first.

Also fail if the script produced **no output at all** and exited `0`. That is not a pass either;
it means the script never ran.

On `DRIFT FOUND`: FAIL if this change added, renamed or removed a variable and did not update
**both** `.env.example` and the README table. Pre-existing drift is reported separately and does
**not** block an unrelated change — split the output into two lists: what this change touched, and
what was already adrift.

Source: `CLAUDE.md` → Environment Variables — keep in sync.

## Step 7 — No secrets or financial data in the diff

```bash
git diff dev...HEAD
```

Scan the added lines for:

- key material: long base64 or hex strings, `-----BEGIN`, `sk_`, `Bearer `, anything that looks
  like a token or password
- a real amount, balance, account identifier or counterparty name — in code, in a fixture, in a
  comment, or in a log call
- a new `console.log` or logger call with an amount, balance, rate, account id or counterparty in
  scope

FAIL on any hit. Financial data leaves the process only as an API response. See
`fx-review/check-financial.md` section 6.

## Step 8 — One financial number verified by hand — CANNOT BE AUTOMATED

Ask the person directly. Do not answer this yourself, and do not infer it from a green test run.

> Step 8 needs you. Name one number this change produces, the value you expect, and how you
> checked it independently of the code.

FAIL if they cannot name one, or if the answer is "the tests pass".

A green suite proves the code matches the tests. It does not prove the tests were right. This
repository has already shipped a hidden gap that way, on fixtures cast past their real type.

If the change genuinely produces no financial number — a documentation edit, a rename — the person
says so explicitly and the step passes with that recorded.

Source: `CLAUDE.md` → Working with AI-Generated Code.

## Step 9 — Commit message

```bash
git log dev..HEAD --format='--- %h%n%s%n%b'
```

Use `dev..HEAD`, not a fixed count — a fixed `-5` both misses branch commits past the fifth and
pulls in `dev` commits this branch never added. Print the body too; trailers are not in the subject.

Check every commit this branch adds:

- [ ] Conventional Commits: `<type>(<scope>): <summary>` where type is one of `feat`, `fix`,
      `chore`, `docs`, `test`, `refactor`, `perf`
- [ ] Summary is **72 characters or fewer**, present tense, **no trailing period**
- [ ] Scope names the area — `fx-buffer`, `treasury`, `auth`, `test-mode`
- [ ] One logical change per commit; unrelated changes are not bundled

`Co-Authored-By` is **fine** and is not checked. Claude Code appends it by default and 17 of the
last 30 commits on `dev` carry it. An earlier version of this step forbade it and cited
`CLAUDE.md` and `engineering.md` — neither mentions trailers at all. That rule was imported from
another repository's policy, was never true here, and made this step fail on commits produced by
the very workflow these skills orchestrate.

This repository already uses this convention — `fix(s3): disable EC2 metadata credential probe`,
`feat(treasury): add live FX rates PoC page`. The gate checks conformance; it does not introduce
a new convention.

Source: `CLAUDE.md` → Git Workflow; `.claude/rules/project/engineering.md`.

## Step 10 — Architectural decision recorded

Ask: did this change decide something a future reader would otherwise re-litigate? A formula, a
storage choice, a security trade-off, a rejected alternative?

- [ ] If yes, it is in `.claude/rules/project/decisions.md` in the existing ADR format.
- [ ] If the change chose to store raw Treasury data, that choice is recorded — see
      `fx-review/check-database.md` section 1.

If it is missing, do not write it silently. Run `fx-record-decision`, which asks for confirmation
first.

Source: `.claude/rules/project/engineering.md` → Claude Behavior Rules.

---

## Report

```
FX PRE-PUSH GATE

  1. Branch not protected .................. PASS  (fix/aws-metadata-lookup-warning)
  2. No protected paths .................... PASS
  3. Types (npx tsc --noEmit) .............. PASS
  4. Tests (npm test) ...................... PASS  (312 passed)
  5. Lint (npm run lint) ................... PASS
  6. Env var drift ......................... PASS  (2 pre-existing, not from this change)
  7. No secrets / financial data ........... PASS
  8. One number verified by hand ........... PASS  (EUR buffer 15.0M, checked against sheet)
  9. Commit message ........................ PASS
 10. Decision recorded ..................... PASS  (n/a - no decision made)

RESULT: READY TO PUSH
```

On success, hand over the command — do not run it:

```bash
git push -u origin HEAD
```

Then tell them the next step is opening a PR against `dev`, never against `main`, and that a PR is
required even for a trivial change.

On failure, print the table up to the failing step, then:

```
RESULT: BLOCKED at step <n>
```

followed by the single concrete action that unblocks it. One action, not a list of possibilities.
