---
name: fx-open-pr
description: Compose a pull request description from what the branch actually did — commits, decisions recorded, knowledge-log entries, verification evidence, open gaps — show it for approval, and create the PR against dev. Use when asked to "open a PR", "create a pull request", "raise the PR", or after fx-pre-push reports READY TO PUSH. Never opens a PR against main, and never creates one without being told to.
user-invocable: true
allowed-tools: Bash(git *), Bash(gh *), Bash(npm *), Bash(npx *), Bash(node *), Bash(cat *), Bash(head *), Bash(tail *), Bash(wc *), Bash(grep *), Bash(rg *), Bash(find *), Read, Grep, Glob, AskUserQuestion
---

# FX Open PR

Turn a branch into a pull request a reviewer can actually act on.

The description is assembled from evidence that already exists — the commits, the ADRs the branch
added, the knowledge-log entries, and the gate's own numbers. It is not a summary written from
memory.

---

## Step 0 — The gate first

```bash
git branch --show-current
git status --short
git log --oneline origin/dev..HEAD
```

Do not compose anything until `fx-pre-push` has passed. A PR description that reports green checks
which were never run is worse than no description — it spends a reviewer's trust on a number
nobody measured.

Stop and say so if:

| What you find | Why it stops here |
|---|---|
| branch is `dev`, `main` or `master` | there is nothing to open a PR *from* |
| uncommitted changes | the PR would describe a tree that is not what you pushed |
| no commits vs `origin/dev` | nothing to review |
| `fx-pre-push` has not been run | you would be reporting unverified claims |

## Step 1 — The branch must already be on the remote

```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "NOT PUSHED"
```

`.claude/settings.json` denies `Bash(git push*)`, so **this skill cannot push for you** — the same
deliberate constraint `fx-pre-push` operates under. If the branch is not on the remote, hand over
the command and stop:

```bash
git push -u origin HEAD
```

`gh pr create` fails without an upstream branch, so there is no point composing the body first.

## Step 2 — Gather the evidence

Each of these answers one section of the description. Run them; do not recall them.

```bash
# what changed, and the reasoning the author already wrote down
git log origin/dev..HEAD --format='--- %h %s%n%b'
git diff --stat origin/dev...HEAD

# decisions this branch recorded
git diff origin/dev...HEAD -- .claude/rules/project/decisions.md | grep '^+## ' || echo "none"

# what the branch learned
git diff origin/dev...HEAD -- docs/knowledge-log.md | grep '^+## ' || echo "none"
```

For the verification section, use the numbers `fx-pre-push` produced. If you do not have them, run
the checks again rather than writing "all green":

```bash
npx tsc --noEmit 2>&1 | wc -l
npm test 2>&1 | grep -E 'Test Files|Tests '
npm audit 2>&1 | tail -3
```

## Step 3 — Compose the description

```markdown
## What this changes

<two or three sentences: the problem, and the shape of the fix. Not a list of files.>

## Why

<the motivation a reviewer cannot get from the diff. Pull it from the commit bodies —
they already carry it — rather than inventing a new explanation.>

## Decisions recorded

<each ADR this branch added to decisions.md, with its title and one line of what it settles.
"None" is a perfectly good answer.>

## What the branch learned

<the knowledge-log entries: measurements taken, approaches rejected, claims corrected.
This is the section that saves the next person from repeating the work.>

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | <actual> |
| `npm test` | <actual counts> |
| `npm run build` | <only if the change touches build-time deps or config> |
| `npm audit` | <only if dependencies changed> |
| hand-verified number | <what was checked by hand, and against what — fx-pre-push step 8> |

## Open / deliberately not done

<gaps left on purpose, with the reason. If a reviewer would otherwise file them as bugs,
they belong here.>

## Where to look first

<the two or three files or hunks that carry the actual risk, and what to check about them.
A reviewer's attention is the scarce resource.>
```

Sections with nothing to say are deleted, not filled with "N/A".

**Two rules about what must never go in the body.** A PR description is outward-facing and
permanent:

- No restricted data. No real balance, account identifier, counterparty, position-linked rate,
  token or connection string — `check-financial.md` section 6 applies here exactly as it applies to
  a log line.
- No claim you did not verify. "Tests pass" without a number, or a green check copied from an
  earlier run on a different tree, is the failure this whole skill exists to prevent.

There is no `.github/PULL_REQUEST_TEMPLATE.md` and this skill does not add one: `.github/` is
platform-managed and must not be changed.

## Step 4 — Show it and wait

Print the full description and ask plainly:

> Here is the PR description. Open the pull request against `dev` with this?

**Wait for a yes.** Opening a PR notifies reviewers and is visible to the team — it is not
reversible in the way a local commit is. Do not create it because the gate went green.

If the answer is no, take the edits and show it again.

## Step 5 — Create it

```bash
gh pr create --base dev --title "<type>(<scope>): <summary>" --body-file <path>
```

- **Base is always `dev`.** Never `main` — `.claude/rules/div/policy.md` makes `main` protected and
  fed only from `dev`. A PR against `main` from a feature branch is a mistake, not a shortcut.
- Title follows Conventional Commits, same rules as a commit subject: 72 characters or fewer,
  present tense, no trailing full stop.
- Write the body to a file and pass `--body-file`. A long `--body` on the command line gets mangled
  by shell quoting, and the failure looks like a formatting bug rather than a quoting one.

Then report the URL.

## What this skill never does

- Push. `.claude/settings.json` denies it, and step 1 hands the command over instead.
- Open a PR against `main`.
- Create a PR without an explicit yes.
- Report a check it did not run.
- Edit `.github/`, or add a PR template.
- Merge anything, or set auto-merge.
