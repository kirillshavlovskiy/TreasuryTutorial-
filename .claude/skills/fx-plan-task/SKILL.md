---
name: fx-plan-task
description: Turn a request into a plan for this repository before any code is written. Use when asked to "plan this", "how should I approach this", "what do I need to change", "break this down", or when given a task whose shape is not obvious. Reads the knowledge layers in precedence order, checks the recorded anti-patterns, and names which review checklists will apply. Produces a plan only — it never implements.
user-invocable: true
allowed-tools: Bash(git *), Bash(ls *), Bash(cat *), Bash(head *), Bash(tail *), Bash(grep *), Bash(rg *), Bash(find *), Read, Grep, Glob, AskUserQuestion
---

# FX Plan Task

Work out what a task actually requires in this repository, then write it down. Do not implement.

---

## Step 1 — Read the knowledge layers, in this order

Precedence matters. A higher layer overrides a lower one.

| Order | Layer | Files | Can it be edited? |
|---|---|---|---|
| 1 | Department | `.claude/rules/dept/` | No — read-only, arrives by `/sync-dept` |
| 2 | Division | `.claude/rules/div/` | No — read-only, arrives by `/sync-division` |
| 3 | Project | `.claude/rules/project/` | Yes — by the team |

Department compliance rules win over everything. Division standards apply unless the project layer
explicitly overrides them for this codebase. Project context applies to this codebase only.

Read what is relevant to the task, not all of it. For anything touching money or a formula, always
read `.claude/rules/project/decisions.md`.

## Step 2 — Check the recorded anti-patterns first

This repository has a long list of decisions where **the obvious approach is the wrong one**. A plan
that walks into one of them wastes an implementation cycle.

Search `decisions.md` and `liquidity-book.md` for the area the task touches. Named traps to check:

- **Liquidity book versus funding swap** — the funding swap never enters the liquidity book cells.
- **Buffer scale** — `computeLayeredBuffer` scales on `|forecasted_cash|`, not `|payout|`.
- **Swap formula** — the forward needs no near leg; do not use `-(spot + fwd)`.
- **VaR basis** — do not conflate forecast period `Tf` with VaR tenure `Th`.
- **Post-quantum crypto** — not for symmetric single-party encryption at rest.
- **Rate source** — JPM Notional Pool rates, never central bank policy rates, for NP carry.

If the task's natural approach contradicts one of these, say so in the plan and pick the recorded
approach. If the task is genuinely asking to *revisit* a recorded decision, flag that explicitly —
it needs a person, and possibly an approval from the owners named in the policy files.

## Step 3 — Stop conditions

Stop and hand back to the person if the task requires:

- changing `helm/`, `argocd/`, `.github/`, `Dockerfile`, `values.yaml` — platform-managed
- changing `.claude/rules/dept/` or `.claude/rules/div/` — read-only; the fix is to raise it with
  the owner and run the sync command, not to edit locally
- **modifying data in Treasury** — never allowed from this codebase; see
  `fx-review/check-financial.md` section 7
- exceeding an approval threshold in `.claude/rules/div/fx-hedging-policy.md` without the named
  approval
- a change to hedging strategy logic — needs FX Lead review per `.claude/rules/div/standards.md`

Say which condition triggered, and what the person needs to do.

## Step 4 — Work out the blast radius

```bash
git grep -n "<symbol>" -- lib app components
```

- Which files change?
- Does the change touch a **shared** function? If so, list every caller. This is where AI-assisted
  changes most often break something they never looked at.
- Does it add or change an environment variable? Then `.env.example` **and** the README table change
  in the same commit.
- Does it store anything new? Then decide the storage question from
  `fx-review/check-database.md` section 1 — store nothing, store an aggregate, or store raw with a
  recorded reason.

## Step 5 — Name the review bar up front

Run the paths from Step 4 through `.claude/skills/fx-review/classify.md` and list the checklists
that will apply.

Put this list in the plan. The author should know the bar before they start, not discover it at
review time.

## Step 6 — Write the plan

Structure:

1. **Goal** — one sentence on what will be true when this is done.
2. **Files to change** — path, and one line on what changes in it.
3. **Approach** — the decision made, and the alternative rejected with a reason. No "consider
   whether" and no "you may want to". Every choice is made here.
4. **Anti-patterns that apply** — from Step 2, with the source entry.
5. **Review checklists that will apply** — from Step 5.
6. **How it will be verified** — including which financial number will be checked by hand, since
   `fx-pre-push` step 8 will demand one.
7. **Open questions** — only genuine ones needing a person. If everything is decided, say so.

## Step 7 — Hand over

> Next step: run `fx-implement` with this plan. It loads the checklists, writes the change, and
> reviews it in a separate sub-agent.

This skill does not implement. If the person asks you to just do it, say that `fx-implement` is the
skill for that and it will follow this plan.
