Upload local project knowledge to Google Drive.

Pushes `.claude/rules/project/` files to the GDrive Projects/<project-name>/ folder so teammates and future sessions can pull the latest context.

If the project folder does not yet exist in GDrive, run `/scaffold-project` first.

Follow these steps exactly. Do not skip any step.

---

## Step 1 — Read configuration

Read `.claude/framework.json`. Extract:
- `project_name` — the project folder name to look for in GDrive
- `division` — current division key
- `department` — current department key

Read `.claude/registry.json`. Extract from the `divisions.[department]` array entry where `key` matches `framework.division`:
- `projects_root.gdrive_folder_id` — GDrive folder containing all project sub-folders

---

## Step 2 — Find project folder in GDrive

Use the Google Drive MCP `search_files` tool to search for a folder named exactly `project_name` inside `projects_root.gdrive_folder_id`.

**If NO folder found:**
  Tell the user: "No GDrive project folder found for [project_name]. Run /scaffold-project first to create it, then re-run /project-commit."
  Stop here.

**If MULTIPLE folders found:**
  Ask the user which one to upload to before proceeding.

**If EXACTLY ONE folder found:**
  Proceed automatically without asking.

---

## Step 3 — Upload project files

Read these local files:
- `.claude/rules/project/context.md`
- `.claude/rules/project/decisions.md`
- `.claude/rules/project/setup.md`
- `.claude/rules/project/engineering.md`

For each file that exists locally:
1. Search GDrive for a file with that exact title inside the project folder
2. **If NOT found in GDrive:** create it using the Google Drive MCP `create_file` tool
3. **If EXACTLY ONE found:** create a new version (GDrive does not enforce unique filenames — a new file will be created alongside the old one; this is expected behaviour for now)
4. **If MULTIPLE files with same title found:** ask the user to confirm which to replace before uploading

Upload parameters:
- `title`: the filename (e.g. `context.md`)
- `mimeType`: `text/plain`
- `parentId`: the GDrive project folder ID found in Step 2
- `content`: base64-encoded content of the local file

---

## Step 4 — Confirm

"Project knowledge uploaded to GDrive — [project_name]
Files uploaded: [list]
Folder: [GDrive folder URL or ID]"

---

SAFETY RULE: This command only writes to GDrive. It never modifies any local files.
