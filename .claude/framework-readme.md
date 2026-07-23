# Claude Knowledge Framework — Overview

> **Knowledge Base** is the single source of truth for all context that Claude Code uses when assisting Treasury engineers.

---

## Folder Structure

```
Knowledge Base/
├─ Framework Documentation/
│  ├─ README — Claude Knowledge Framework   # this file
│  └─ Setup Guide — Claude Deel Treasury    # step-by-step install guide
└─ Treasury/                                      ↔ LAYER 1: Department knowledge (read-only in Claude)
    ├─ department.md                         Org structure, mission, cross-team standards
    ├─ compliance.md                         Regulatory requirements, data classification
    ├─ engineering.md                        Code standards, API conventions, testing
    └─ FX Team/                              ↔ LAYER 2: Division knowledge (read-only in Claude)
        ├─ division.md                       Team overview, goals, ownership
        ├─ standards.md                      Coding standards, PR checklist
        ├─ policy.md                         Branching, deployment, on-call
        └─ Projects/                         ↔ LAYER 3: Project knowledge (editable by team)
            └─ <project-name>/
                ├─ context.md                Sprint goals, stakeholders, key links
                ├─ decisions.md              Architecture decisions (ADRs)
                └─ setup.md                  Dev environment, commands, gotchas
```

---

## Layer Rules

| Layer | Folder | Who edits | How Claude uses it |
|-------|--------|-----------|---------------------|
| Department | `Treasury/` | Department head | Read-only — synced to `.claude/rules/dept/` |
| Division | `Treasury/FX Team/` | Team lead | Read-only — synced to `.claude/rules/div/` |
| Project | `FX Team/Projects/<name>/` | All developers | Synced to `.claude/rules/project/` — team can edit |

---

## How to Sync

Inside a Claude Code session, use slash commands:

```
/sync-dept      — pulls Treasury/ docs into .claude/rules/dept/
/sync-division  — pulls FX Team/ docs and Projects/<name>/ into .claude/rules/div/ and .claude/rules/project/
```

Or via CLI:

```
claude-deel-treasury sync dept
claude-deel-treasury sync division
```

---

## How to Add a New Project

1. Create a new folder inside `FX Team/Projects/` named exactly after your git repo
2. Copy the three template files: `context.md`, `decisions.md`, `setup.md`
3. In your project repo, run: `claude-deel-treasury init`
4. Run: `/sync-division` inside Claude Code to pull content

---

## Precedence

`Treasury/` compliance rules always override all other instructions.
`FX Team/` standards apply unless `Projects/<name>/` explicitly overrides.
`Projects/<name>/` context applies to that specific codebase only.

---

## Maintained by

- Deel Treasury FX Team
- package: `claude-deel-treasury` (npm)
- Slack: TODO - add your team channel
