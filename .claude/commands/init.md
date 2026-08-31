Initialize this project with the Deel Treasury knowledge framework.

Run this command once after cloning a new repo — or when the .claude/ folder is missing.

This command runs inside Claude Code where the Google Drive MCP is already authenticated.
It does NOT require gcloud, ADC, or any OAuth setup. GDrive sync is automatic.

---

## Overview

This command will:
1. Ask a few project questions
2. Create all .claude/ folders and framework files
3. Fetch framework docs from GDrive automatically
4. Fetch department knowledge from GDrive automatically (Treasury/)
5. Fetch division knowledge from GDrive automatically (FX Team/)
6. Write project starter files (.claude/rules/project/)
7. Write CLAUDE.md with framework notation
8. Write .claude/framework.json
9. Commit everything

No manual sync steps required. Everything happens here.

---

## Step 1 — Gather project info

Ask the user these questions one at a time:

1. "What is the project name?" (default: current directory name from `pwd`)
2. "What is this project building?" (1-2 sentence description)
3. "Project type?" — offer choices: Next.js + Tailwind CSS / Python / Node.js service / Other

Store answers as: `$PROJECT_NAME`, `$PROJECT_PURPOSE`, `$PROJECT_TYPE`

---

## Step 2 — Create folder structure

Run:
```
mkdir -p .claude/rules/dept .claude/rules/div .claude/rules/project .claude/commands
```

---

## Step 3 — Copy slash commands

Copy all files from this commands directory into `.claude/commands/`:
- Check if `.claude/commands/` already has files — if so, ask "Overwrite existing slash commands? (y/n)"
- Copy: `sync-dept.md`, `sync-division.md`, `sync-project.md`, `scaffold-project.md`, `update-claude-md.md`, `init.md`

---

## Step 4 — Copy registry

Read `.claude/registry.json` if it exists. If it does NOT exist, use the values below (these are the canonical GDrive folder IDs):

```json
{
  "framework_docs_folder_id": "1t4gpsSjmqITdHqD9_BgDg4E5SFdb-Eh4",
  "framework_docs_folder_name": "Framework Documentation",
  "knowledge_base_docs": [
    {
      "gdrive_file_id": "1KahTthzSeOqsZKefl4CNCW0CCgGK__CVzsBlvuyXRxU",
      "title": "README — Claude Knowledge Framework",
      "local_path": "framework-readme.md"
    },
    {
      "gdrive_file_id": "1BpeScM34C2TbLJvVtofsKBkvkzquuN7uwrXnqKshpko",
      "title": "Setup Guide — Claude Deel Treasury Framework",
      "local_path": "framework-setup.md"
    }
  ],
  "departments": [
    {
      "key": "treasury",
      "label": "Treasury",
      "source": {
        "type": "gdrive",
        "gdrive_folder_id": "1Mz1sX0SI2TXQzE93a_cg2Z8Fq3NJp8h1",
        "gdrive_folder_name": "Treasury"
      }
    }
  ],
  "divisions": {
    "treasury": [
      {
        "key": "fx",
        "label": "FX Team",
        "gdrive_knowledge_root": {
          "folder_id": "1GCtnAJjcngaVdPOurusnxkhEU-BWPYIS",
          "folder_name": "Knowledge Base"
        },
        "dept_folder": {
          "type": "gdrive",
          "gdrive_folder_id": "1Mz1sX0SI2TXQzE93a_cg2Z8Fq3NJp8h1",
          "gdrive_folder_name": "Treasury"
        },
        "source": {
          "type": "gdrive",
          "gdrive_folder_id": "19rqdRvMX824j95NPPZvPxd1YRQNtt_n_",
          "gdrive_folder_name": "FX Team"
        },
        "projects_root": {
          "type": "gdrive",
          "gdrive_folder_id": "1-mgs00yGB539IkpOdueIzhfaS-neLKrH",
          "gdrive_folder_name": "Projects"
        }
      }
    ]
  }
}
```

Write this to `.claude/registry.json` (overwrite if exists).

---

## Step 5 — ALWAYS fetch framework docs (mandatory — no conditions, no skipping)

This step is UNCONDITIONAL. Always run it. Never skip it.

Use the Google Drive MCP to read by file ID (faster than searching by name):

1. Read file ID `1KahTthzSeOqsZKefl4CNCW0CCgGK__CVzsBlvuyXRxU`
   → Write full content to `.claude/framework-readme.md` (OVERWRITE always)

2. Read file ID `1BpeScM34C2TbLJvVtofsKBkvkzquuN7uwrXnqKshpko`
   → Write full content to `.claude/framework-setup.md` (OVERWRITE always)

If GDrive MCP returns an error for either file:
- Write a placeholder: `# [Title]\n\n_GDrive not available — run /sync-dept to fetch._`
- Continue — do NOT stop the init flow

---

## Step 6 — Fetch department knowledge (Treasury/)

Dept folder ID: `1Mz1sX0SI2TXQzE93a_cg2Z8Fq3NJp8h1`

For each of these 3 files, search by title within the Treasury/ folder using the Google Drive MCP:

1. Search for file titled `department.md` in folder `1Mz1sX0SI2TXQzE93a_cg2Z8Fq3NJp8h1`
   → Read its content → Write to `.claude/rules/dept/department.md` (OVERWRITE always)

2. Search for file titled `compliance.md` in folder `1Mz1sX0SI2TXQzE93a_cg2Z8Fq3NJp8h1`
   → Read its content → Write to `.claude/rules/dept/compliance.md` (OVERWRITE always)

3. Search for file titled `engineering.md` in folder `1Mz1sX0SI2TXQzE93a_cg2Z8Fq3NJp8h1`
   → Read its content → Write to `.claude/rules/dept/engineering.md` (OVERWRITE always)

If a file is not found in GDrive:
- Write placeholder: `# [Title]\n\n> Source: GDrive Treasury/\n> DO NOT edit — run /sync-dept to fetch\n\n_Not yet synced._`
- Continue to next file

SAFETY: Write ONLY to `.claude/rules/dept/`. Never touch div/ or project/ in this step.

---

## Step 7 — Fetch division knowledge (FX Team/)

Div folder ID: `19rqdRvMX824j95NPPZvPxd1YRQNtt_n_`

For each of these 3 files, search by title within the FX Team/ folder using the Google Drive MCP:

1. Search for file titled `division.md` in folder `19rqdRvMX824j95NPPZvPxd1YRQNtt_n_`
   → Read its content → Write to `.claude/rules/div/division.md` (OVERWRITE always)

2. Search for file titled `standards.md` in folder `19rqdRvMX824j95NPPZvPxd1YRQNtt_n_`
   → Read its content → Write to `.claude/rules/div/standards.md` (OVERWRITE always)

3. Search for file titled `policy.md` in folder `19rqdRvMX824j95NPPZvPxd1YRQNtt_n_`
   → Read its content → Write to `.claude/rules/div/policy.md` (OVERWRITE always)

If a file is not found in GDrive:
- Write placeholder: `# [Title]\n\n> Source: GDrive FX Team/\n> DO NOT edit — run /sync-division to fetch\n\n_Not yet synced._`
- Continue to next file

SAFETY: Write ONLY to `.claude/rules/div/`. Never touch dept/ or project/ in this step.

---

## Step 8 — Find or create project folder in GDrive

Projects root folder ID: `1-mgs00yGB539IkpOdueIzhfaS-neLKrH`

1. List subfolders inside the Projects/ folder (ID: `1-mgs00yGB539IkpOdueIzhfaS-neLKrH`)
2. Check if a folder named `$PROJECT_NAME` already exists
3. If it exists: use its folder ID as `$PROJECT_GDRIVE_ID`
4. If it does NOT exist:
   - Ask: "No GDrive project folder found for '$PROJECT_NAME'. Create it now? (y/n)"
   - If yes: inform the user they need to create it manually at:
     https://drive.google.com/drive/folders/1-mgs00yGB539IkpOdueIzhfaS-neLKrH
     and press Enter when done, then re-check
   - If no or GDrive unavailable: set `$PROJECT_GDRIVE_ID` to null and continue

---

## Step 9 — Write project starter files

Write these files to `.claude/rules/project/` — only if they do NOT already exist:

### `.claude/rules/project/context.md`
```markdown
# Project Context

> Maintained by: all team members
> Update this file as context changes. Commit alongside the related code.

## Project

**Name:** $PROJECT_NAME
**Purpose:** $PROJECT_PURPOSE
**Department:** treasury
**Division:** FX Team

## Sprint Goals

- [ ] TODO: Add current sprint goals

## Active Blockers

None.

## Stakeholders

- TODO: Add stakeholders

## Key Links

- TODO: Add links
```

### `.claude/rules/project/decisions.md`
```markdown
# Architecture Decisions

> Maintained by: all team members
> Document decisions when they are made, not after the fact.
> Commit alongside the code that implements the decision.

## Format

**Decision:** What was decided
**Alternatives considered:** What else was evaluated
**Reason:** Why this choice was made
**Anti-patterns:** What NOT to do as a result of this decision

---

## Active Decisions
```

### `.claude/rules/project/setup.md`
```markdown
# Project Setup

> Maintained by: all team members
> Keep build commands, env vars, and gotchas current.

## Prerequisites

- Node.js (version: TODO)
- TODO: Add other prerequisites

## Install

```bash
npm install
```

## Development

```bash
npm run dev
```

## Build

```bash
npm run build
```

## Test

```bash
npm test
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| TODO     | TODO        | Yes      |

## Known Gotchas

- TODO
```

---

## Step 10 — Write CLAUDE.md

Write `CLAUDE.md` in the project root — only if it does NOT already exist.

Content:
```markdown
# Knowledge framework — read this before anything else

This project uses the Deel Treasury three-layer shared knowledge framework.
You must understand the layers before acting on any instruction.

## Framework documentation (above all layers — always auto-fetched)

The two files below are framework-level reference docs. They sit OUTSIDE the dept/div/project hierarchy.
They are fetched automatically on every /sync-dept and during /init.

@.claude/framework-readme.md
@.claude/framework-setup.md

---

## Knowledge model

DEPARTMENT knowledge → lives in Google Drive (Treasury/) → synced to .claude/rules/dept/
DIVISION knowledge   → lives in Google Drive (FX Team/)  → synced to .claude/rules/div/
PROJECT knowledge    → lives in this repo                → .claude/rules/project/

## Layer rules

LAYER 1 — dept/ (read-only — GDrive Treasury/)
- Source: official policies, compliance rules, department-level engineering standards
- Owner: department head — maintained in Google Drive Knowledge Base
- NEVER suggest editing any file under .claude/rules/dept/
- If content seems outdated: tell the user to run /sync-dept
- Sync uses: Google Drive MCP

LAYER 2 — div/ (read-only here — editable in GDrive)
- Source: division standards, code style, PR checklist, team guidelines
- Owner: team lead — maintained in Google Drive (FX Team/)
- NEVER suggest editing any file under .claude/rules/div/
- If content seems outdated: tell the user to run /sync-division
- Sync uses: Google Drive MCP

LAYER 3 — project/ (editable by all team members)
- Source: this project's context, decisions, and setup — lives in this repo
- Owner: all developers
- CAN and SHOULD suggest updates when decisions are made or context changes
- Update directly and commit alongside the related code change

## Precedence

dept/ compliance rules always win over all other instructions.
div/ standards apply unless project/ explicitly overrides for this codebase.
project/ context applies to this codebase only.

## Sync commands (slash commands inside Claude Code)

/sync-dept        — fetches from GDrive Treasury/ → writes .claude/rules/dept/
/sync-division    — fetches from GDrive FX Team/  → writes .claude/rules/div/ and .claude/rules/project/

## When project knowledge needs updating

1. Complete the coding task first
2. Say: "I noticed [X] is not captured in project knowledge. Should I update [file]?"
3. Wait for confirmation, then write ONLY to .claude/rules/project/ files
4. Never touch dept/ or div/ files — those are sync-managed

# End of framework notation

@.claude/rules/dept/framework-readme.md
@.claude/rules/dept/department.md
@.claude/rules/dept/compliance.md
@.claude/rules/dept/engineering.md

@.claude/rules/div/division.md
@.claude/rules/div/standards.md
@.claude/rules/div/policy.md

@.claude/rules/project/context.md
@.claude/rules/project/decisions.md
@.claude/rules/project/setup.md
```

If CLAUDE.md already exists:
- Read it
- If it contains `# Knowledge framework` already, skip writing (don't overwrite)
- Otherwise append the framework notation block at the top

---

## Step 11 — Write .claude/framework.json

Write `.claude/framework.json`:

```json
{
  "framework_version": "1.2",
  "package": "claude-deel-treasury",
  "project_name": "$PROJECT_NAME",
  "project_purpose": "$PROJECT_PURPOSE",
  "project_type": "$PROJECT_TYPE",
  "department": "treasury",
  "division": "fx",
  "division_label": "FX Team",
  "installed_at": "[ISO timestamp of now]",
  "installed_by": "/init slash command",
  "gdrive_knowledge_root": {
    "folder_id": "1GCtnAJjcngaVdPOurusnxkhEU-BWPYIS",
    "folder_name": "Knowledge Base"
  },
  "dept_knowledge_source": {
    "type": "gdrive",
    "gdrive_folder_id": "1Mz1sX0SI2TXQzE93a_cg2Z8Fq3NJp8h1",
    "gdrive_folder_name": "Treasury"
  },
  "division_config_source": {
    "type": "gdrive",
    "gdrive_folder_id": "19rqdRvMX824j95NPPZvPxd1YRQNtt_n_",
    "gdrive_folder_name": "FX Team"
  },
  "projects_root": {
    "type": "gdrive",
    "gdrive_folder_id": "1-mgs00yGB539IkpOdueIzhfaS-neLKrH",
    "gdrive_folder_name": "Projects"
  },
  "this_project": {
    "name": "$PROJECT_NAME",
    "gdrive_folder_id": "$PROJECT_GDRIVE_ID_OR_NULL"
  },
  "include_layers": {
    "dept": true,
    "div": true,
    "project": true
  },
  "selected_files": {
    "dept": ["department.md", "compliance.md", "engineering.md"],
    "div": ["division.md", "standards.md", "policy.md"],
    "project": ["context.md", "decisions.md", "setup.md"]
  },
  "protected_paths": [".claude/rules/dept/", ".claude/rules/div/"],
  "editable_paths": [".claude/rules/project/"]
}
```

---

## Step 12 — Git commit

Stage all framework files:
```
git add CLAUDE.md .claude/
```

Show a diff summary (`git diff --cached --stat`), then ask:
"Commit the framework installation? (y/n)"

If yes, commit with message:
```
chore(claude): install Deel Treasury knowledge framework

- Framework docs: fetched from GDrive Framework Documentation/
- Dept knowledge: fetched from GDrive Treasury/
- Div knowledge: fetched from GDrive FX Team/
- Project: $PROJECT_NAME
```

---

## Step 13 — Summary

Print a summary:

```
Knowledge framework installed for: $PROJECT_NAME

  Framework docs:
    ✓ .claude/framework-readme.md
    ✓ .claude/framework-setup.md

  Department knowledge (Treasury/):
    ✓ .claude/rules/dept/department.md
    ✓ .claude/rules/dept/compliance.md
    ✓ .claude/rules/dept/engineering.md

  Division knowledge (FX Team/):
    ✓ .claude/rules/div/division.md
    ✓ .claude/rules/div/standards.md
    ✓ .claude/rules/div/policy.md

  Project files:
    ✓ .claude/rules/project/context.md
    ✓ .claude/rules/project/decisions.md
    ✓ .claude/rules/project/setup.md

To re-sync knowledge at any time:
  /sync-dept       — refreshes dept/ from GDrive Treasury/
  /sync-division   — refreshes div/ and project/ from GDrive FX Team/
```

---

SAFETY RULES:
- Never write to `.claude/rules/dept/` from project/ content
- Never write to `.claude/rules/div/` from dept/ content
- Never overwrite `.claude/rules/project/` files that already have real content (non-placeholder)
- dept/ and div/ files are ALWAYS overwritten with latest from GDrive
