Sync department knowledge from Google Drive into this project.

This layer is READ-ONLY — official Treasury policies, compliance rules, dept-level engineering standards.
Source: Google Drive folders referenced in framework.json.
Requires: Google Drive MCP configured in .mcp.json.

Follow these steps exactly. Do not skip any step.

---

## Step 1 — Read configuration

Read `.claude/framework.json`. Extract:
- `gdrive_knowledge_root.folder_id` — the Knowledge Base root folder in GDrive
- `dept_knowledge_source.gdrive_folder_id` — GDrive folder containing dept knowledge files
- `selected_files.dept` — which dept files to sync (e.g. ["department.md", "compliance.md", "engineering.md"])

Read `.claude/registry.json`. Extract:
- `framework_docs_folder_id` — the `Framework Documentation/` subfolder ID inside Knowledge Base

---

## Step 2 — ALWAYS fetch framework docs (mandatory — no conditions, no skipping)

This step is UNCONDITIONAL. Always run it. Never skip it. Never check if files already exist.

Use `framework_docs_folder_id` from `.claude/registry.json` to search within the `Framework Documentation/` folder in Google Drive.

Fetch BOTH documents and ALWAYS overwrite local files, even if they already exist:

1. Search for file titled exactly: `README — Claude Knowledge Framework`
   → OVERWRITE: `.claude/framework-readme.md`

2. Search for file titled exactly: `Setup Guide — Claude Treasury Framework`
   → OVERWRITE: `.claude/framework-setup.md`

Rules:
- Do NOT check if the files exist first — always download and overwrite
- Do NOT ask the user — these are fetched silently on every sync
- Do NOT write to `.claude/rules/` — these live at `.claude/` root only

---

## Step 3 — Sync dept/ files

Use the Google Drive MCP tool to read files from `dept_knowledge_source.gdrive_folder_id`.

For each file in `selected_files.dept`:
- Search for the file by exact title within the dept source folder
- Read its content
- Write to `.claude/rules/dept/<filename>` (always overwrite)

Standard dept files:
- `department.md`  — org structure, mission, Treasury divisions, cross-team standards
- `compliance.md`  — data classification, security rules, regulatory requirements
- `engineering.md` — code style, API conventions, review standards, testing, deployment

SAFETY: Do NOT write to `.claude/rules/div/` or `.claude/rules/project/`.

---

## Step 4 — Stage changes

```
git add .claude/framework-readme.md .claude/framework-setup.md .claude/rules/dept/
```

---

## Step 5 — Show diff

```
git diff --cached --stat
```

---

## Step 6 — Propose commit

```
docs(knowledge): sync department knowledge — [today's date]
- Framework docs: GDrive/Knowledge Base/Framework Documentation/ ([framework_docs_folder_id])
- Dept source: GDrive/Knowledge Base/Treasury/ ([dept_knowledge_source.gdrive_folder_id])
- Updated: framework-readme.md, framework-setup.md, [list changed dept files]
```

---

## Step 7 — Confirm and commit

Ask: "Commit these changes? (y/n)"
If yes, commit with the proposed message.

---

## Step 8 — Confirm

"Department knowledge synced. Files updated: [list]"

---

SAFETY RULE: Never modify `.claude/rules/div/` or `.claude/rules/project/` during this command.
