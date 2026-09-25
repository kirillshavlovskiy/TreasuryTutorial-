# AGENTS.md — agent instructions for this repository

This file exists because of a gap that is narrower than it first looks, and worth stating
precisely. Cursor **does** read `CLAUDE.md` — its docs say it picks the file up automatically and
applies it to every conversation, for compatibility with Claude Code. What is **not** documented
anywhere is whether Cursor follows the `@.claude/rules/**` imports inside it, and fifteen of this
repository's sixteen rule files live behind those imports. Codex and Copilot read `AGENTS.md` and
not `CLAUDE.md` at all.

So this file does not replace `CLAUDE.md`. It makes the read-list explicit so that nothing
load-bearing depends on an undocumented import behaviour. If you are Claude Code, ignore this file
and use `CLAUDE.md`.

This repository processes real financial data — balances, FX rates, hedges, exposures. A wrong
number here is a production incident, not a cosmetic bug. Read the rules before you write code.

---

## 1. Read these first

This file is deliberately short. It is a pointer and a summary, **not** the rules. The rules live
in the files below, and they win wherever this summary is thinner than they are. Read the ones
that touch your task before you start.

| Layer | Files | Who owns it |
|---|---|---|
| **Repository** | `CLAUDE.md` | this repo — tech stack, security, financial data, Next.js, git, error handling |
| **Department** (read-only) | `.claude/rules/dept/{department,compliance,engineering}.md` | Treasury dept head, synced from Google Drive |
| **Division** (read-only) | `.claude/rules/div/{division,standards,policy,fx-hedging-policy,fx-hedging-strategy,fx-rate-mesh,fxall-integration}.md` | FX team lead, synced from Google Drive |
| **Project** (team-editable) | `.claude/rules/project/{context,decisions,setup,engineering,tms-mcp,liquidity-book}.md` | everyone on this repo |

**Precedence:** `dept/` compliance beats everything. `div/` standards apply unless `project/`
overrides them for this codebase. `project/` applies to this codebase only.

**`decisions.md` is not optional reading.** It records what was already decided and, in each
entry's *Anti-patterns* section, the specific mistakes that have already been made here. Several
of them look like obvious improvements until you read why they are wrong.

---

## 2. Rules you cannot talk your way around

Breaking any of these is a CRITICAL finding in review. This list is a summary; the sources above
are authoritative.

**Money and financial data**
- Money and FX rates never use plain JavaScript arithmetic. Use `Decimal.js` for anything that
  aggregates, converts or compares monetary amounts.
- Financial data is never logged — not to logs, error messages, telemetry, URL query strings,
  commit messages, or test fixtures. Account identifiers, balances and counterparty data are
  sensitive.
- Every rate carries an explicit uppercase ISO 4217 currency code and an explicit
  timestamp/source. There is no implicit "current rate".
- Log the *decision*, not just the result, for anything that sizes or executes a position.
- Approval thresholds are hard stops in code, not warnings. See `div/fx-hedging-policy.md`.
- Financial writes must be idempotent — a retried request must not double-book.
- **We never write to Treasury.** We read from Treasury and write only to our own database.

**Process**
- **Never commit to `dev` or `main`.** Branch (`feature/…`, `fix/…`, `chore/…`, `docs/…`), then
  open a pull request. One reviewer minimum; two on payment-path changes.
- Conventional Commits, one logical change per commit, ticket reference in the footer.
- Never `--no-verify`. Never force-push a shared branch.
- `tsc --noEmit` clean and the full test suite green before you push. A green suite proves the
  code matches the tests, not that the tests were right — **hand-verify at least one real number**
  on any financial change.
- Before "fixing" a failing test, work out whether the bug is in the test or the implementation.
  Changing an assertion to match current behaviour is only correct if that behaviour is intended.

**Never touch**
- `helm/`, `argocd/`, `.github/`, `Dockerfile`, `values.yaml` — platform-managed. Changing them
  breaks the deployment pipeline.
- `.claude/rules/dept/` and `.claude/rules/div/` — read-only mirrors of Google Drive. Local edits
  are silently overwritten by the next sync. `.claude/rules/project/` is the layer this team edits.

**Stack — no substitutions**
- Next.js App Router · PostgreSQL · Sequelize · TypeScript strict · `ioredis`/`bullmq` if Redis.
- No new dependency beyond what the task needs. Every library is new attack surface and new audit
  burden.

**Environment variables**
- `.env.example` and the Environment Variables table in `README.md` must describe the same set.
  Change one, change the other, in the same commit. Check with:
  ```bash
  node .claude/skills/fx-review/scripts/env-drift.mjs
  ```

---

## 3. Skills

The eleven `fx-*` skills in `.claude/skills/` are the rules turned into runnable steps. **Cursor loads
them** — `.claude/skills/` is one of its compatibility skill directories — so type `/` and pick
one, or let the agent choose. Read `.claude/skills/README.md` for what each does.

```
fx-explain-model  →  fx-plan-task  →  fx-implement  →  fx-ship  →  fx-pre-push  →  you push  →  fx-open-pr
                                       (experiment:      (review + unit
                                        no review,        tests in two
                                        no tests,         agents, then
                                        no commit)        commit)
                                                               ↓
                                                    fx-log-knowledge after every commit
                                                         (docs/knowledge-log.md)
                                                               ↑
                                                    fx-review (also runs standalone)
```

`fx-record-decision` writes to `.claude/rules/project/` whenever you decide something a future
reader would otherwise have to re-argue.

---

## 4. What Cursor does not give you

Be honest with yourself about this. Four things work in Claude Code and do not work here:

1. **`allowed-tools:` in a `SKILL.md` is not a Cursor field.** Cursor documents seven frontmatter
   keys and that is not one of them, so assume it does nothing. `fx-review` and `fx-explain-model`
   declare themselves read-only; under Cursor that is a promise in prose, not a restriction — do
   not let either of them edit code.
2. **The `/sync-dept`, `/sync-division`, `/sync-project` and `/project-commit` slash commands do
   not exist in Cursor.** They are Claude Code commands. From Cursor use the CLI instead:
   `claude-deel-treasury sync dept`, `claude-deel-treasury sync division`.
3. **Reviews should run in a separate agent.** `fx-review` and `fx-ship` require it, on Opus 5
   or better. (One scoped exception inside `fx-ship`: the agent judging *test coverage* runs on
   Sonnet. The code review does not.) The reason is measured, not theoretical: the first review of the skill set itself
   found three CRITICAL bugs the authoring context had missed. If you cannot spawn a subagent,
   start a fresh Cursor conversation for the review rather than reviewing in the context that
   wrote the code.
4. **`.claude/settings.json` is not read by Cursor.** The protected-path guard and the command
   deny list are ported to `.cursor/hooks.json` — see section 5. If that file is missing or
   Cursor's hooks are disabled, nothing outside this document stops you editing `helm/`.

Two of these rest on Cursor's current documented behaviour and will rot silently when it changes.
Skill loading from `.claude/skills/` is a compatibility feature, and Cursor gates third-party
configs behind a Settings toggle — if `/fx-review` does not appear when you type `/`, check
Settings before assuming the skill is broken.

---

## 5. Guards that run outside the model

`.cursor/hooks.json` wires `.cursor/hooks/protected-paths-cursor.mjs` into three Cursor events.

The adapter holds no *path*-matching rules of its own — every decision about **which paths** are
protected comes from `checkPath` in `.claude/hooks/protected-paths.mjs`, so Claude Code and Cursor
cannot drift apart on that. It does add shell-command matching, which exists only there and is
heuristic; treat that part as new code, not as a translation layer.

| Event | What it does |
|---|---|
| `preToolUse` (`Write`, `Delete`) | **Blocks** an edit to a protected path before it happens |
| `beforeShellExecution` | **Denies** a `git push` whose resolved target is `dev`/`main`/`master` (via the shared `push-guard.mjs`), `git reset --hard`, `git clean`, `rm -rf`, `DROP TABLE/DATABASE`; **asks** before a shell command that looks like it writes to a protected path |
| `postToolUse` (`Write`, `Delete`) | Backstop for a write that arrived some other way. It runs after the write, so it **reports** and asks for a revert |

Not `afterFileEdit`, which is the event that looks right for that last row and is not: Cursor
documents it as observe-only, so a message returned there is discarded. Every report is also
written to stderr, so a dropped message still leaves a trace.

Two honest gaps. `.cursor/hooks.json` and the adapter are themselves ordinary editable files, so
two edits disable the guard. And nothing enforces any of this once you leave the editor — you run
`git push` to a feature branch yourself or let the agent do it. This stops the accidental edit. It
does not stop a determined one. Do not
route around it.

Run the guard's tests with:

```bash
npx vitest run .cursor .claude
```

---

## 6. Keeping this file honest

This file duplicates `CLAUDE.md` in summary form, and a summary drifts. Two rules keep it usable:

- **`CLAUDE.md` and `.claude/rules/` are the source of truth.** When they disagree with section 2,
  they win, and section 2 is the thing that needs fixing.
- **Do not grow this file.** New rules go in the layer that owns them. Section 2 only changes when
  a rule becomes non-negotiable, and then it changes in the same commit as the source.
