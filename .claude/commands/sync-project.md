Pull project knowledge from Google Drive into this project.

Fetches `.claude/rules/project/` files from GDrive Projects/<project-name>/ and overwrites local copies.
Run this at the start of a session to get the latest context committed by teammates.

For uploading local project knowledge back to GDrive, use /project-commit instead.
For syncing division wiki files, use /sync-division. For department files, use /sync-dept.

Follow these steps exactly. Do not skip any step.

---

## Step 1 — Read configuration

Read `.claude/framework.json`. Extract:
- `project_name` — used to locate the project folder in GDrive
- `division` — current division key (e.g. "fx")
- `department` — current department key (e.g. "treasury")

Read `.claude/registry.json`. Extract from the `divisions.[department]` array entry where `key` matches `framework.division`:
- `projects_root.gdrive_folder_id` — GDrive folder containing all project sub-folders for this division

---

## Step 2 — Find project folder in GDrive

Use the Google Drive MCP `search_files` tool to search for a folder named exactly `project_name` inside `projects_root.gdrive_folder_id`.

**If NO folder found:**
  Tell the user: "No GDrive project folder found for [project_name]. Run /scaffold-project to create it, then /project-commit to upload your local files."
  Stop here.

**If MULTIPLE folders found:**
  Ask the user which one to pull from before proceeding.

**If EXACTLY ONE folder found:**
  Proceed automatically without asking.

---

## Step 3 — Pull project files from GDrive

For each standard project file: `context.md`, `decisions.md`, `setup.md`, `engineering.md`
- Search for the file by exact title within the project folder
- If found: read its content and write to `.claude/rules/project/<filename>` (overwrite)
- If not found in GDrive: skip silently (keep local version unchanged)

SAFETY: Write ONLY to `.claude/rules/project/`. Never touch dept/ or div/ files.

---

## Step 4 — Stage changes

```
git add .claude/rules/project/
```

---

## Step 5 — Show diff and auto-commit

```
git diff --cached --stat
```

If there are staged changes, commit automatically (no confirmation needed):
```
docs(knowledge): sync project knowledge from GDrive — [today's date]
- Project: [project_name]
- Files updated: [list]
```

If there are no staged changes, say: "Project files are already up to date."

---

## Step 6 — Confirm

"Project knowledge synced — [project_name]
- Files updated: [list, or 'none — already up to date']"

---

SAFETY RULE: This command only writes to `.claude/rules/project/`. Never touch dept/ or div/ files.
