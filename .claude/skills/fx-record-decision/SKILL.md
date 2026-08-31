---
name: fx-record-decision
description: Record an architecture decision in this project's knowledge files. Use when asked to "record this decision", "write this to decisions.md", "document why we did this", "update the project context", or when fx-pre-push step 10 finds a decision that is not written down. Writes only to .claude/rules/project/ and only after explicit confirmation.
user-invocable: true
allowed-tools: Bash(git *), Bash(ls *), Bash(cat *), Bash(head *), Bash(tail *), Bash(grep *), Read, Write, Edit, Grep, AskUserQuestion
---

# FX Record Decision

Write a decision into the project knowledge layer. Nothing else.

---

## Hard rules

These come from `.claude/rules/project/engineering.md` → Claude Behavior Rules. They are not
suggestions.

1. **Only write after the person explicitly confirms.** Never fill these files in speculatively
   from inferred context.
2. **Only write to `.claude/rules/project/`.** Never `dept/`, never `div/` — those are read-only and
   sync-managed. A hook blocks an in-place edit there, but **not** a full `Write` — that exemption
   exists for the sync commands, not for you. This skill is allowed to use `Write`, so the guard
   will not stop you. Do not use it on those two layers.
3. **Write only the fact that was discussed.** Do not expand the file beyond the single update
   asked for. No extra sections, no extra examples, no commentary.
4. If content in `dept/` or `div/` looks wrong or outdated, the answer is "run `/sync-dept`" or
   "run `/sync-division`", or raise it with the owner. Never edit it locally.

## Which file

| File | Holds | Update when |
|---|---|---|
| `decisions.md` | architecture decisions (ADRs) | a meaningful architectural choice was made |
| `context.md` | sprint goals, stakeholders, blockers | a goal completes, or a blocker changes |
| `setup.md` | environment, commands, env vars, gotchas | setup changed or a new gotcha was found |
| `engineering.md` | team engineering practices | a practice changed |
| `liquidity-book.md` | the liquidity-book invariant | that invariant changes — rare |

## Step 1 — Confirm before writing

Ask, and wait for an answer:

> I noticed `<X>` is not captured in project knowledge. Should I add it to `<file>`?

If they say no, stop. Do not write.

## Step 2 — Check it is not already there

```bash
grep -n -i "<key phrase>" .claude/rules/project/decisions.md
```

If an entry already covers it, **update that entry** rather than adding a near-duplicate. Say which
entry you are updating.

## Step 3 — Write it in the existing format

`decisions.md` uses this shape. Match it exactly — do not invent a new one.

```
## <short title>

**Date:** YYYY-MM-DD
**Decision:** What was decided (one sentence)
**Alternatives considered:** What else was evaluated
**Reason:** Why this choice was made
**Anti-patterns:** What NOT to do as a result — prevents future re-debates
**Ticket:** FX-XXX
```

Guidance per field:

- **Date** — today's actual date. Convert any relative date ("last sprint") to an absolute one.
- **Decision** — one sentence. If it needs two, it is two decisions.
- **Alternatives considered** — what was actually evaluated and rejected. "None" is a valid answer
  if nothing else was on the table; do not invent alternatives.
- **Reason** — why, in enough detail that someone can tell whether the reasoning still holds later.
- **Anti-patterns** — the most valuable field. Write what a future reader must **not** do, and be
  concrete. "Do not use `|payout|` as the buffer scale" is useful; "be careful with scale" is not.
- **Ticket** — the Jira id, or `—` if there is none.

Add the entry at the end of the file unless it belongs next to a related one.

## Step 4 — context.md

For a completed sprint goal, tick the existing checkbox — do not rewrite the line:

```
- [x] <the goal exactly as it was written>
```

For a new blocker, add it under Active Blockers. When the last one clears, the section reads `None.`

## Step 5 — Confirm what you wrote

Show the exact text added and the file. Then stop.

Do not also update `README.md`, `CLAUDE.md`, or any other file unless you were asked to.

## Sharing with the team

Local project files are the source of truth for this repository. If the team also keeps them in
Google Drive, `/project-commit` uploads `.claude/rules/project/` there. Mention it; do not run it
unasked.
