Link this repository to a project folder in Google Drive and upload local project knowledge files.

Run this inside Claude Code after `claude-treasury-framework init` has been run once.
Requires: Google Drive MCP configured in .mcp.json.

Follow these steps exactly. Do not skip any step.

---

## Step 1 — Read configuration

Read `.claude/framework.json`. Extract:
- `project_name` — current project name
- `this_project.gdrive_folder_id` — set if already linked, null/missing if not

Read `.claude/registry.json`. Extract from the `divisions.[department]` array entry where `key` matches `framework.division`:
- `projects_root.gdrive_folder_id` — GDrive folder containing all project sub-folders

---

## Step 2 — Resolve project folder

Search GDrive for a folder titled exactly `project_name`.

**Case A — folder found in GDrive:**
- Use that folder ID
- If `this_project.gdrive_folder_id` was already set to the same ID: skip to Step 5 (already linked, just upload)
- If different or not set: update `framework.json` with the found folder ID, then go to Step 5

**Case B — folder NOT found in GDrive:**
- Create it using GDrive MCP `create_file` with `mimeType = application/vnd.google-apps.folder` and `parentId = projects_root.gdrive_folder_id`
- Use the new folder ID
- Go to Step 4

---

## Step 3 — (Only if multiple projects exist and name is ambiguous)

If the title search returns multiple folders with the same name, show a numbered list and ask the user to pick one. Otherwise proceed automatically.

---

## Step 4 — Update framework.json

Write `this_project.gdrive_folder_id`, `this_project.name`, `this_project.gdrive_folder_url` into `.claude/framework.json`.

---

## Step 5 — Upload local project files to GDrive

Upload each file in `selected_files.project` from `.claude/rules/project/<filename>` to the GDrive project folder.

- Use `create_file` with `mimeType: text/plain`, `disableConversionToGoogleType: true`, `parentId`: project folder ID
- Upload all files in parallel
- Skip files that don't exist locally

---

## Step 6 — Stage and auto-commit framework.json if changed

```
git add .claude/framework.json
git diff --cached --stat
```

If changed, auto-commit:
```
chore(claude): link project to GDrive — [project_name]
- GDrive folder: [folder_id]
- Uploaded: [list of files]
```

---

## Step 7 — Confirm

"Project '[project_name]' linked to GDrive.
Folder: [gdrive_folder_url]
Files uploaded: [list]"

---

SAFETY RULE: Never modify `.claude/rules/dept/` or `.claude/rules/div/` during this command.
