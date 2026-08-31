---
name: fx-implement
description: Implement a change in this repository against the project's standards, then review it in a separate sub-agent and fix what the review finds, looping up to three times, then commit it. Use when asked to "implement this", "build this", "make this change", "fix this", "code this up", or after fx-plan-task has produced a plan. Loads the relevant checklists before writing any code. Commits the result; does not push and does not open a PR.
user-invocable: true
allowed-tools: Bash(git *), Bash(npm *), Bash(npx *), Bash(node *), Bash(ls *), Bash(cat *), Bash(head *), Bash(tail *), Bash(grep *), Bash(rg *), Bash(find *), Bash(mkdir *), Read, Write, Edit, Grep, Glob, Agent, AskUserQuestion
---

# FX Implement

Write the change, then have a fresh reviewer tear it apart, then fix what it found. Repeat at most
three times.

The point of the loop is that the agent which wrote the code is bad at finding its own mistakes.
The reviewer must start from a clean context.

---

## Step 0 — Know what you are allowed to touch

Stop immediately and hand back to the person if the task requires changing:

- `helm/`, `argocd/`, `.github/`, `Dockerfile`, `values.yaml` — platform-managed
- `.claude/rules/dept/`, `.claude/rules/div/` — read-only, arrive by sync

A hook blocks these paths, but stopping early saves wasted work. Say which path and why, and ask
how they want to proceed.

Confirm the branch is not protected:

```bash
git branch --show-current
```

If it is `dev`, `main` or `master`, create a feature branch before writing anything:

```bash
git switch -c <feature|fix|chore|docs>/<short-description>
```

## Step 1 — Load the standards **before** writing code

This is the step people skip, and it is the one that saves the loop iterations.

1. Work out which files the change will touch.
2. Read `.claude/skills/fx-review/classify.md` and select the checklists those paths and signals map
   to.
3. **Read those `check-*.md` files now.**

Standards are an input to the implementation, not a test applied afterwards. A change written
against the checklist usually clears review in one iteration; a change written blind usually needs
all three.

Also read, for anything touching a formula or a financial model:

- `.claude/rules/project/decisions.md` — the anti-patterns there forbid the *obvious* approach in
  several places. Check before you choose an approach, not after.
- `.claude/rules/project/liquidity-book.md` — a hard dashboard invariant.

If you are unsure what a formula does or why it is shaped that way, run `fx-explain-model` first.

## Step 2 — Implement

Keep the change to what was asked.

- Do not add features beyond the request.
- Do not refactor surrounding code unless it directly blocks the task.
- Do not create a new file when an existing one can be extended.
- Do not create helper utilities, index files, barrel exports or abstraction layers unless asked.
- Do not add comments or docstrings to code you did not change.

Before changing a shared function's name, type, or return meaning, **grep for every caller** and
list them. Fixing one call site while breaking another is the most common failure of AI-assisted
edits here.

Source: `CLAUDE.md` → What NOT to do, Working with AI-Generated Code;
`.claude/rules/project/engineering.md` → File and component creation limits.

## Step 3 — Verify it runs before you review it

Do not send a broken change to review. Run these first:

```bash
npx tsc --noEmit
```

**Four errors are expected and are not yours.** They were on `dev` before your change, in
`lib/cash-carry-path.test.ts` and `lib/cfar-cover.test.ts`. `fx-pre-push` step 3 lists all four
verbatim — compare against that list.

| What you see | Do this |
|---|---|
| exactly those four | continue |
| a fifth | it is yours — fix it |
| fewer than four, or different wording | someone changed those two files; the list in `fx-pre-push` step 3 is now stale and must be updated as part of that change |

**Do not try to fix the four.** Deleting the imports does not work — the parked tests below them
still call those functions, so the same errors come back with a different number.
`fx-review/check-tests.md` section 7 explains the only cleanup that works, and whether to do it at
all is the FX team's call, not yours.

```bash
npm test
```

Fix anything else failing here yourself. A reviewer's time is for design and correctness, not for
compile errors.

## Step 4 — Review in a separate sub-agent

Launch the review with the `Agent` tool:

- `subagent_type`: `general-purpose`
- `model`: `opus` — **Opus 5 minimum**, or a newer model of the same or a higher class. Never a
  smaller model.
- Reasoning effort: **high or above**.

Give the sub-agent:

- the diff (`git diff dev...HEAD` plus any uncommitted changes)
- the list of checklists from Step 1, and instructions to read them from
  `.claude/skills/fx-review/`
- the anti-patterns section of `.claude/skills/fx-review/SKILL.md`
- the review brief (see below for where it lives), copied in full
- an explicit instruction: **return findings only — no fixes, no patches**

**The review brief** — what the sub-agent must actually look for — lives in
`.claude/skills/fx-review/SKILL.md` under "The review brief". Copy it into the sub-agent prompt in
full. It is kept in one place on purpose: a checklist that exists in two copies drifts, and the
copy that falls behind is the one that stops catching things.

## Step 5 — Fix what the review found

Fix by severity, most severe first. For each finding either fix it, or say plainly why it is not a
defect. "I disagree" needs a reason a reviewer could check.

**Do not downgrade a severity to close the loop.** If a finding is CRITICAL, it stays CRITICAL until
it is fixed or shown to be wrong on the merits.

## Step 6 — Loop, at most three times

Repeat Steps 3 to 5. **Maximum three review iterations.**

After the third iteration:

- **No CRITICAL findings left** → done. Report what changed across the iterations and hand over to
  `fx-pre-push`.
- **CRITICAL findings left** → **stop.** Do not run a fourth iteration. Do not reclassify the
  finding to make the loop terminate.

Report it like this:

```
FX IMPLEMENT — STOPPED after 3 review iterations

Unresolved CRITICAL:
  1. <file>:<line> — <what is wrong> — <what goes wrong because of it>
  2. ...

Fixed across iterations: <n> findings (<m> CRITICAL, <k> HIGH)

This needs a decision from you. Three attempts did not resolve the items above.
```

Three failed iterations means the problem is the approach, not the code. That is a human decision.

## Step 7 — Commit

Nothing downstream works on an uncommitted tree. `fx-pre-push` step 9 reads `git log dev..HEAD`;
with no commit that returns nothing, every check passes vacuously, and the push sends nothing.

**First look at what would go in.** Do not skip this:

```bash
git status --short
```

Read every line. A file you did not touch in this task does not belong in this commit — that
includes anything an earlier command staged for you. Unstage it:

```bash
git restore --staged <path>
```

This is not hypothetical. A `git rm` run during exploration once rode along silently into an
unrelated commit and had to be split back out.

**Then stage and commit:**

```bash
git add <the files this change touched>
git commit
```

The message follows Conventional Commits:

```
<type>(<scope>): <summary>

<why this change, not what it does — the diff shows what>

Refs <TICKET-ID>
```

- **type** — `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`
- **scope** — the area: `fx-buffer`, `treasury`, `auth`, `skills`, `test-mode`
- **summary** — 72 characters or fewer, present tense, **no full stop at the end**
- **body** — explain the motivation. A reviewer can read the diff; they cannot read your reasoning.

**One logical change per commit.** If this task did two unrelated things, make two commits. Do not
bundle them because it is faster.

A `Co-Authored-By` trailer is fine and is not checked.

If the commit fails a hook, read what it says and fix that — do not reach for `--no-verify`.

## Step 8 — Hand over

State clearly:

- what changed, by file
- what the review found and what was fixed
- which model and effort the reviews ran on
- anything left open

Then:

> Next step: run `fx-pre-push`. It runs the full gate and gives you the push command.
> This skill commits, but it does not push and does not open a PR.

## What this skill never does

- Push, or run any `git push` variant. `.claude/settings.json` denies it.
- Open a pull request.
- Commit to `dev`, `main` or `master`. It commits only to a feature branch — see step 0.
- Commit with `--no-verify`.
- Change a file under `helm/`, `argocd/`, `.github/`, `Dockerfile`, `values.yaml`,
  `.claude/rules/dept/` or `.claude/rules/div/`.
- Modify data in Treasury. We read from Treasury and write only to our own service — see
  `fx-review/check-financial.md` section 7.
- Write to `decisions.md` without explicit confirmation — use `fx-record-decision`.
