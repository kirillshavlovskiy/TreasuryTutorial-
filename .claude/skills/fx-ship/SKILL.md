---
name: fx-ship
description: Take an experiment you are happy with and make it shippable — a code review and a unit-test author run as two separate agents, the tests get their coverage judged by a third, findings are fixed over at most three review rounds, and the result is committed. Use when asked to "ship it", "I'm happy with this", "let's push", "I'm done experimenting", "make this ready", or when an experiment has settled into something worth keeping. Commits; does not push and does not open a PR.
user-invocable: true
allowed-tools: Bash(git *), Bash(npm *), Bash(npx *), Bash(node *), Bash(ls *), Bash(cat *), Bash(head *), Bash(tail *), Bash(wc *), Bash(grep *), Bash(rg *), Bash(find *), Bash(mkdir *), Bash(pwd), Bash(xargs *), Read, Write, Edit, Grep, Glob, Agent, AskUserQuestion
---

# FX Ship

This project is experimental. While you are exploring, reviewing and testing every attempt is work
thrown away — it slows the loop down and protects nothing, because most of what you write will be
replaced before anyone else sees it.

So all of the checking happens **here**, once, on the thing you actually decided to keep.

Two agents start together: one reviews the change, one writes its unit tests. The tests then get
their coverage judged by a third. Nothing about the standards is relaxed — what changed is only
*when* they are applied.

```
you experiment (fx-plan-task → fx-implement, no review, no tests, no commit)
        │
        ↓  "I'm happy with this"
    fx-ship
        │
        ├─ Agent R: review          ─┐
        │  opus or fable             │ read in parallel
        └─ Agent T: write tests     ─┘
              └─ Agent TR: coverage review (sonnet), ≤2 rounds
        │
        ↓  only now is source edited
    fix → fresh Agent R → ≤3 rounds → reconcile → commit
        │
        ↓
    fx-pre-push
```

---

## Step 0 — Preflight

Two agents are expensive. Do not send them a broken tree.

```bash
git branch --show-current
git status --short
npx tsc --noEmit
npm test
```

| What you find | Do this |
|---|---|
| branch is `dev`, `main` or `master` | **STOP.** `git switch -c <feature\|fix\|chore\|docs>/<short-description>` first |
| a protected path in the diff | **STOP.** `helm/`, `argocd/`, `.github/`, `Dockerfile`, `values.yaml`, `.claude/rules/dept/`, `.claude/rules/div/` — revert it and say which |
| nothing changed | nothing to ship. Say so and stop |
| `tsc` reports anything, or a test fails | fix that first. A reviewer's time is for design, not compile errors |

`tsc` must be **zero errors**. There is no baseline to compare against.

## Step 1 — Snapshot the diff

Both agents read a **file**, not a live `git diff`. This is load-bearing, not tidiness: Agent T
writes into this same worktree while Agent R is reading it, so a live diff would shift underneath
the reviewer and produce a verdict on a tree that no longer exists.

```bash
git fetch origin dev
mkdir -p .claude/tmp
git ls-files --others --exclude-standard -z | xargs -0 -r git add -N   # new files into the diff
git diff origin/dev...HEAD  > .claude/tmp/ship.diff
git diff                   >> .claude/tmp/ship.diff
git diff --cached          >> .claude/tmp/ship.diff
git diff --name-only origin/dev...HEAD
```

`git add -N` stages nothing — it records intent to add, which is the only way an untracked file
shows up in `git diff` at all. Skip it and a brand-new file is invisible to both agents.

**Use exactly that `-z | xargs -0` form.** An unquoted `$(git ls-files …)` word-splits, so one
untracked path containing a space anywhere in the tree makes the whole `git add -N` fail with
`fatal: pathspec 'Screen' did not match any files` — no file gets intent-to-add, and the snapshot
comes back empty. `-r` also stops `xargs` running the command at all when there is nothing
untracked.

Diff against `origin/dev`, not local `dev` — a local `dev` that has not been fetched can be weeks
behind, and then the snapshot contains other people's work as if it were yours.

**Give the agents the ABSOLUTE path.** A sub-agent's working directory is not guaranteed to be
yours, so a relative `.claude/tmp/ship.diff` is a file it may not find. Run `pwd` and pass the
full path.

`.claude/tmp/` is gitignored, so the snapshot cannot ride along into a commit and there is nothing
to clean up afterwards.

## Step 2 — Launch both agents, in one message

Put both `Agent` calls in a **single** message or they run one after the other and you lose the
whole point.

**Agent R — the review.**

- `subagent_type`: `general-purpose`
- `model`: `opus` — **Opus 5 minimum**, per `fx-review/SKILL.md`, which is the authority on this.
  `fable` is also acceptable **because the user named it explicitly** when this workflow was
  agreed, not because this repository establishes anything about its model class. Never a smaller
  model.
- Give it: the snapshot path, the checklists that apply (from `fx-review/classify.md`), the
  anti-patterns section of `fx-review/SKILL.md`, and **"The review brief" from
  `fx-review/SKILL.md`, copied in full**.
- Tell it: **findings only — no fixes, no patches.**

The brief lives in one place on purpose. A checklist that exists in two copies drifts, and the copy
that falls behind is the one that stops catching things.

**Agent T — the unit tests.** Same model class. Its brief is below, under "Writing the tests".

**About reasoning effort.** The `Agent` tool accepts `model` and has **no** `effort` parameter.
`fx-review/SKILL.md` → "About reasoning effort" is the single description of what to do about that;
follow it. In short: if `Workflow` is available and the user opted into it, `agent()` takes both;
otherwise effort is inherited from the session and **you say so in your report** rather than
claiming you set it.

## Step 3 — Hold the review findings until the tests are done

Reads run in parallel. **Writes do not.**

Do not edit a single source file until Agent T's loop (step 4) has finished. If Agent R returns
first, hold its findings and say nothing to Agent T about them.

The reason is concrete: Agent T runs `npx tsc --noEmit` and `npm test` in this worktree to check
its own work. If you are applying review fixes at the same time, it sees half-applied edits as
compile errors and either writes tests against a state that never existed or reports failures that
are yours, not the code's.

The wall-clock saving is in the reading and the reasoning, which stays parallel. Only the writing
is ordered.

## Step 4 — Judge the test coverage, at most twice

When Agent T reports, launch **Agent TR** with `model: sonnet` and the coverage-review brief below.

If TR finds gaps, launch a **fresh** test-author agent with the snapshot, the list of test files
written so far, and TR's findings in the prompt. **Maximum 2 rounds.**

Every hand-off carries its state in the prompt. **Do not build this on `SendMessage`** — it is not
always available (it is disabled in some sessions, subagents included), and a design that resumed
an agent's context would then simply not run. A fresh author also matches this repository's own
reasoning about fresh reviewers; the cost is a re-read each round, which is why the cap is 2.

## Step 5 — Review the tests too, then fix everything, at most three rounds

Now source may change.

**Re-snapshot first, and always run one Agent R pass over the new test files.** This is not
optional and it is not conditional on round 1 having found something:

```bash
git ls-files --others --exclude-standard -z | xargs -0 -r git add -N
git diff origin/dev...HEAD  > .claude/tmp/ship.diff
git diff                   >> .claude/tmp/ship.diff
git diff --cached          >> .claude/tmp/ship.diff
git ls-files --others --exclude-standard; git diff --name-only; git diff --cached --name-only
```

**The `git add -N` is what makes this work.** Agent T writes *new* files (`lib/x.ts` →
`lib/x.test.ts`), and `git diff` shows nothing at all for an untracked file. Without the
intent-to-add the snapshot comes back with zero lines of the very tests this pass exists to
review, Agent R reports clean, and the tests reach the commit judged only by the Sonnet agent —
which is the failure this step was added to prevent. Use the `-z | xargs -0 -r` form for the
reason given in step 1; an unquoted `$(…)` breaks on a single filename with a space.

An intent-to-add entry shows as `A <path>` in `git status --short` but is **not** included by
`git commit` unless it is really staged, so step 7's "read every line" still applies and nothing
half-added can ride along. **Pass Agent R the explicit list of test file
paths as well as the snapshot**, so it can read them directly and does not depend on the diff
alone.

Agent R in step 2 read a snapshot taken **before** Agent T wrote a single line. Without this pass,
a run where the first review came back clean would commit test code that no Opus-class reviewer
ever saw — judged only by the Sonnet coverage agent. That matters concretely: `classify.md` marks
an `as` type assertion inside a `*.test.ts` as **CRITICAL**, and `check-tests.md` section 1 calls
it the single most important item in the file. `.claude/skills/README.md` promises the reader that
the code review stays on Opus 5 or better; test code is code.

Fix by severity, most severe first. For each finding, either fix it or say plainly why it is not a
defect — "I disagree" needs a reason a reviewer could check.

**Do not downgrade a severity to close the loop.** A CRITICAL stays CRITICAL until it is fixed or
shown to be wrong on the merits.

Each round gets a **fresh** Agent R and a **fresh** snapshot. **Maximum three rounds.**

After the third:

- **No CRITICAL left** → done, continue to step 6.
- **CRITICAL left** → **stop.** No fourth round, and no reclassifying to make the loop terminate.

```
FX SHIP — STOPPED after 3 review rounds

Unresolved CRITICAL:
  1. <file>:<line> — <what is wrong> — <what goes wrong because of it>

Fixed across rounds: <n> findings (<m> CRITICAL, <k> HIGH)
Tests written: <n> cases in <files>
Reviews ran on: <model>, effort <inherited from session | set via Workflow>

This needs a decision from you. Three attempts did not resolve the items above.
```

Three failed rounds means the problem is the approach, not the code. That is a human decision.

## Step 6 — Reconcile the tests with the fixes

A fix in round 3 can invalidate a test written in step 4 against round-1 code.

```bash
npx tsc --noEmit
npm test
```

A written test that now fails is **not** closed by editing its expected value. Decide whether the
bug is in the implementation or in the test, and say which — `fx-review/check-tests.md` section 3
is the procedure. Re-baselining an assertion to whatever the code currently returns is how a green
suite comes to prove nothing.

## Step 7 — Commit

**First look at what would go in:**

```bash
git status --short
```

Read every line. A file you did not touch in this task does not belong in this commit — including
anything an earlier command staged for you:

```bash
git restore --staged <path>
```

This is not hypothetical. A `git rm` run during exploration once rode along silently into an
unrelated commit and had to be split back out.

The snapshot needs no cleanup — `.claude/tmp/` is gitignored, so it cannot be staged.

**Stage and commit:**

```bash
git add <the files this change touched>
git commit
```

```
<type>(<scope>): <summary>

<why this change, not what it does — the diff shows what>

Refs <TICKET-ID>
```

- **type** — `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`
- **scope** — the area: `fx-buffer`, `treasury`, `auth`, `skills`, `test-mode`, `local-stack`
- **summary** — 72 characters or fewer, present tense, **no full stop**
- **body** — the motivation. A reviewer can read the diff; they cannot read your reasoning.

**One logical change per commit.** Two unrelated things means two commits.

`Co-Authored-By` is fine and is not checked. If a hook rejects the commit, read what it says and
fix that — never `--no-verify`.

## Step 8 — Hand over

State: what changed by file; what the review found and what was fixed; how many tests were written
and what they cover; **which model each agent ran on and where its effort came from**; and anything
left open.

Then, **before anything else**, run `fx-log-knowledge`. It appends one entry to
`docs/knowledge-log.md` for the commit step 7 just made: what you measured, what you tried and
rejected, what you left open, what existing claim you found to be false. Most entries are three
lines, and the one that says `No finding beyond the commit message.` is a valid entry.

Do it now rather than later — that knowledge only exists in this session, and it is the part the
diff cannot carry. A `PostToolUse` hook will remind you if you forget.

> Next step: run `fx-pre-push`. It runs the full gate and gives you the push command.
> After that, `fx-open-pr` composes the pull request description from the branch's own evidence and
> opens it once you approve.
> This skill commits, but it does not push and does not open a PR.

---

# Writing the tests — the brief for Agent T

Read `.claude/skills/fx-review/check-tests.md` **first**. Then:

**Test the business requirement, not the implementation.** A test name says what the behaviour is —
`'returns USD when exposure is zero'`, never `'calls getBalance'`. The question to ask of every
case you write is: **would this still pass if the change were reverted?** If yes, it is testing
nothing.

**Fixtures satisfy the real type.** No `as` cast — review treats one in a test as CRITICAL, because
a cast that papers over missing fields hides exactly the bugs types exist to catch, and this
repository has already shipped a gap that way. When a fixture is awkward, reuse the real production
factory (`makeSimRow` in `lib/fx-buffer.ts` is the established one) rather than hand-rolling a
partial object.

**Fake data only.** Never a real balance, account identifier or counterparty name, not even in a
comment. A committed fixture is a permanent, searchable copy of restricted data.

**Cover the FX edge cases explicitly:** zero exposure, single-currency portfolio, and a restricted
currency. For a rate change: conversion, exposure aggregation and hedge ratio each need direct
coverage. For a VAR change: validate against a known historical scenario.

**Money assertions come from an independent calculation**, with the arithmetic written into the test
as a comment showing how the expected number was reached. An assertion copied from what the code
printed proves the code agrees with itself.

**Co-locate:** `lib/x.ts` → `lib/x.test.ts`. Never under `.claude/worktrees/` — `vitest.config.mts`
excludes that path because those are separate checkouts.

**Touch no source file.** Not to fix a bug, not to make something testable. If a test cannot be
written without changing source, report that as a finding and stop.

**A failing test is not yours to make green.** `npx tsc --noEmit` must be clean — a type error in
your test is usually a real bug in the fixture or in the function under test. But run `npm test` to
**observe**, not to force green. If a test fails because the implementation looks wrong:

- leave it in place,
- report it with the expected value, the actual value, and the arithmetic behind the expected one,
- let the fix loop resolve it.

Never adjust the assertion to match current behaviour, and never `.skip` it. Those are the two
things `check-tests.md` sections 3 and 7 exist to prevent, and a "make the suite green" instruction
is exactly what pressures an author into both.

**No DOM dependency, ever.** `vitest.config.mts` runs `environment: 'node'`, and there is no jsdom
or `@testing-library/*` in `package.json`. For a change that is purely UI, the honest output is the
finding *"not unit-testable in this repository without a DOM environment"* — test the extracted
pure logic in `lib/` instead. Do not add jsdom to make a test possible; a new dependency is new
attack surface and new audit burden, and it is not yours to add here.

---

# Judging the coverage — the brief for Agent TR (sonnet)

Read-only. Return findings by severity. Do not edit anything.

Judge:

1. **Business requirements of the change with no test at all.** Read the diff, list what it is
   meant to do, and say which of those things nothing exercises.
2. **Tests that would still pass if the change were reverted.** The strongest single signal of a
   test that costs maintenance and buys nothing.
3. **Assertions that merely restate the implementation** — the expected value transparently copied
   from what the code does, with no independent derivation.
4. **`as` casts, or fixtures that do not satisfy the real type.** CRITICAL.
5. **Real-looking financial data** — a plausible balance, account identifier or counterparty in a
   fixture or comment. CRITICAL.
6. **Missing FX edge cases**: zero exposure, single-currency portfolio, restricted currency.
7. **Money assertions with no arithmetic shown**, so nobody can check where the number came from.

## Why this one review runs on a smaller model

`.claude/rules/project/decisions.md` (GL-926) says plainly: *"Do not run a review on a smaller
model to save tokens."* `.claude/skills/README.md` says reviews run on Opus 5 or better.

This is a deliberate, scoped exception, made by the user: **the coverage review of *tests* runs on
Sonnet. The code review stays Opus 5 or better.** Judging whether a test exercises a listed
requirement is a narrower job than finding a defect nobody has named yet.

It is recorded in `.claude/rules/project/decisions.md` — see *"Review and test authoring happen
at ship time"* — so it is not quietly "fixed" back on the strength of GL-926 alone. `project/`
wins over a skill file, which is why the exception has to live there and not only here.

Nobody should read it as licence to move the **code** review down a model class. Do not. And note
step 5: the test files themselves still get an Opus-class review pass.
