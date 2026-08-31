# Skills for this repository

This repository processes financial data. The rules that keep it safe are written down in
`CLAUDE.md` and in `.claude/rules/`. These skills turn those rules into steps you can run, so you
get the right process without having to remember it exists.

You do not need to be a software engineer to use them. Each skill tells you what it is doing, what
it found, and what to do next.

---

## Which skill do I need?

| You want to… | Run | It gives you |
|---|---|---|
| check a number on the dashboard that looks wrong | `fx-explain-model` | which of three things is wrong — the data, the formula, or the display |
| understand a formula or a number before touching it | `fx-explain-model` | plain-language explanation, the decision behind it, what must not change |
| work out what a task requires | `fx-plan-task` | a plan with every choice already made |
| make the change | `fx-implement` | the change, reviewed by a second agent and fixed, then committed |
| check someone's change, or your own | `fx-review` | findings by severity, no edits |
| push or open a pull request | `fx-pre-push` | ten checks, a PASS/FAIL table, and the push command |
| write down a decision you made | `fx-record-decision` | an entry in `decisions.md`, after you confirm it |

## The normal path

```
fx-explain-model   (only if you do not yet understand what you are changing)
        |
   fx-plan-task    -> a plan
        |
   fx-implement    -> code, review-and-fix up to 3 rounds, then commit
        |
   fx-pre-push     -> verdict + the git push command for you to run
        |
      you push, then open a PR against dev
```

`fx-review` sits inside `fx-implement`, and you can also run it on its own — to look at someone
else's branch, or to check your work before committing.

`fx-record-decision` is called whenever you decide something a future reader would otherwise have
to re-argue.

## Two things happen automatically

**Reviews run in a separate agent, on Opus 5 or better.** The agent that wrote a change is bad at
finding its own mistakes. A fresh reviewer finds more. The skills set this up; you do not have to.

**Some files are blocked.** A hook (`.claude/hooks/protected-paths.mjs`) refuses edits to protected
paths, and it runs outside the model. `.claude/rules/project/` is yours to edit.

Know exactly how far that reaches, because it is narrower than it looks:

| Path | Blocked for | Not blocked for |
|---|---|---|
| `helm/`, `argocd/`, `.github/`, `Dockerfile`, `values.yaml` | the four file tools — Edit, Write, NotebookEdit, MultiEdit | anything through Bash (`sed -i`, `>`, `cp`) |
| `.claude/rules/dept/`, `.claude/rules/div/` | in-place edits (Edit, NotebookEdit, MultiEdit) | a full `Write`, and Bash |

Why the second row is deliberately partial: `/sync-dept` and `/sync-division` refresh those layers
**by overwriting those exact files**. Blocking every write would make the knowledge layers
impossible to update, and the refusal would name the command it had just refused.

**Three honest gaps.** The hook's matcher covers file tools only, so a shell redirect reaches any
path. `.claude/hooks/protected-paths.mjs` and `.claude/settings.json` are themselves editable, so
two ordinary edits disable the guard. And nothing enforces any of this outside a Claude session —
there are no git hooks installed, and the person runs `git push` themselves.

So this is a strong guard against the accidental edit and no guard at all against a determined one.
The remaining defence is `fx-pre-push` step 2, which fails on any protected path in the diff — and
that is prose a model follows, not a gate. If you route around it, nothing stops you. Do not.

## Rules you cannot talk your way around

These come from `CLAUDE.md` and `.claude/rules/`. The review marks any breach as CRITICAL.

- **Money never uses plain JavaScript arithmetic.** Use `Decimal.js`. A rounding error in a hedging
  calculation is a production incident.
- **Financial data is never logged.** It leaves the process only as an API response, to a caller
  that is authenticated and authorised. Not to logs, error messages, telemetry, URLs, commit
  messages, or test fixtures.
- **We never change data in Treasury.** We read from Treasury; we write only to our own database.
- **Prefer storing nothing.** If you must store something from Treasury, prefer an aggregate over
  raw rows, and write down why. Every copy drifts from the source and widens the attack surface.
- **Never commit to `dev` or `main`.** Branch, then open a pull request.
- **One number gets checked by hand before every push.** A green test suite proves the code matches
  the tests, not that the tests were right.

## If a skill tells you to stop

It means the next step needs a person, not more attempts. Common cases:

| Message | What it means |
|---|---|
| a protected path is in your change | revert that file; ask the platform team |
| three review rounds did not clear a CRITICAL finding | the approach is wrong, not the code |
| an approval threshold would be exceeded | `.claude/rules/div/fx-hedging-policy.md` names who approves |
| the change contradicts a recorded decision | read the entry in `decisions.md` before overriding it |

Do not work around a stop by rephrasing the request.

---

## Writing rules for these skills

If you edit a skill, keep it readable for someone who is not a software engineer:

1. Short sentences. One instruction per sentence.
2. Imperative for steps: "Run the command", not "the command should be run".
3. One term per concept. Do not alternate between "check", "verify" and "validate".
4. No assumed vocabulary. Define a term the first time, or link to where it is defined.
5. Give the exact command, not a description of it.
6. Say plainly when to stop, and what the person must do instead.

## Files

```
.claude/skills/
├── README.md                  this file
├── fx-plan-task/SKILL.md
├── fx-implement/SKILL.md
├── fx-review/
│   ├── SKILL.md               orchestrator
│   ├── classify.md            which checklists apply to which files
│   ├── check-financial.md     money, rates, audit trail, limits, leakage, Treasury boundary
│   ├── check-database.md      Sequelize, transactions, what to store
│   ├── check-security.md      secrets, encryption, OAuth, cookies
│   ├── check-typescript.md    types, naming, dead code
│   ├── check-env-vars.md      .env.example, README table and code kept in sync
│   ├── check-nextjs-api.md    App Router, sessions, error shape
│   ├── check-tests.md         fixtures, failing tests, hand-verified numbers
│   └── scripts/env-drift.mjs  environment variable audit (+ tests)
├── fx-pre-push/SKILL.md
├── fx-record-decision/SKILL.md
└── fx-explain-model/SKILL.md

.claude/hooks/
└── protected-paths.mjs        blocks edits to protected paths (+ tests)
```

The two scripts have test coverage. Run it with:

```bash
npx vitest run .claude
```
