# Setup Guide — Claude Deel Treasury Framework

Comprehensive step-by-step instructions from scratch to your first Claude Code session.

---

## Part 1 — Prerequisites

### 1.1 Install Node.js

1. Go to: https://nodejs.org
2. Download the **LTS** version (v20 or newer)
3. Run the installer and follow the defaults

Verify:
```
node --version   # should print v20.x or newer
npm --version    # should print 10.x or newer
```

### 1.2 Fix PowerShell Execution Policy (Windows only)

By default Windows blocks npm scripts from running in PowerShell.
Run this once in PowerShell (permanent fix):

```
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

When prompted, type: Y and press Enter. This only needs to be done once per machine.

### 1.3 Install Claude Code

```
npm install -g @anthropic/claude-code
```

Verify:
```
claude --version
```

---

## Part 2 — Framework Installation

### 2.1 Install the CLI

```
npm install -g claude-deel-treasury
```

Verify:
```
claude-deel-treasury --version
```

Update to latest any time:
```
npm install -g claude-deel-treasury@latest
```

### 2.2 Set your authentication token

Obtain your DEEL_TREASURY token from the FX Team lead.

Set it permanently:

Windows (PowerShell):
```
[System.Environment]::SetEnvironmentVariable("DEEL_TREASURY_TOKEN", "dlt_yourtokenhere", "User")
```

macOS / Linux (add to ~/.zshrc or ~/.bashrc):
```
export DEEL_TREASURY_TOKEN="dlt_yourtokenhere"
```

Verify your token:
```
claude-deel-treasury auth
```

You should see: "✓ Token valid"

---

## Part 3 — Initialize a Project

### 3.1 Create or navigate to your project folder

```
mkdir my-project
cd my-project
git init
```

### 3.2 Run init

```
claude-deel-treasury init
```

The interactive flow will ask:
1. Project name — defaults to folder name
2. What is this project building? — short description
3. Project type — Next.js / Python / Node.js / Other
4. Include department knowledge? — Y recommended
5.   Select department — pick Treasury
6.   Department files to include — select all
7. Include division knowledge? — Y recommended
8.   Select division — pick FX Team
9.   Division files to include — select all
10.  Select project in GDrive Projects/ — pick your project or create new
11.  Project files to include — select all
12. Configure MCP servers? — Y for first time
13. Create in Nexus + Deel-Playground? — Y to set up GitHub repo
14. Commit the framework files to git? — Y

### 3.3 What gets created

```
README.md                           # project root (standard)
CLAUDE.md                           # framework instructions for Claude
.claude/framework.json              # config (folder IDs, sources, selections)
.claude/framework-readme.md         # framework overview (pre-filled from npm)
.claude/framework-setup.md          # this guide (pre-filled from npm)
.claude/rules/dept/                 # department knowledge (pre-filled from npm)
.claude/rules/div/                  # division knowledge (pre-filled from npm)
.claude/rules/project/              # project knowledge (editable)
.claude/commands/                   # Claude Code slash commands
.mcp.json                           # MCP server config
```

---

## Part 4 — Keep Knowledge Up to Date

Knowledge is pre-filled at install time from npm templates. Sync commands update specific layers.

### Open Claude Code

```
cd my-project
claude
```

### Sync department knowledge

```
/sync-dept
```

Fetches: framework-readme.md, framework-setup.md from Framework Documentation/
         department.md, compliance.md, engineering.md from Treasury/

Division files (div/) are pre-filled from npm and maintained locally — they are NOT overwritten by any sync command.

### Sync division knowledge

```
/sync-division
```

Updates wiki-sourced div files only: fx-rate-mesh.md, fxall-integration.md (pulled from Deel Wiki).
Division config files (division.md, standards.md, policy.md, etc.) are maintained locally — never overwritten.

### Sync project knowledge

```
/sync-project
```

Pulls project files from GDrive Projects/<name>/: context.md, decisions.md, setup.md, engineering.md.
Run this at the start of a session to get the latest context committed by teammates.

### Upload project knowledge to GDrive

```
/project-commit
```

Uploads local .claude/rules/project/ files to GDrive Projects/<project-name>/
Run this after updating context.md, decisions.md, setup.md, or engineering.md to share with the team.

---

## Part 5 — Daily Usage

### Open Claude Code

```
cd my-project
claude
```

### Available slash commands

```
/sync-dept        Refresh dept/ layer from GDrive Treasury/
/sync-division    Refresh wiki-sourced div files from Deel Wiki
/sync-project     Pull project/ files from GDrive Projects/<name>/
/project-commit   Upload local project/ files to GDrive Projects/<name>/
/scaffold-project Link this repo to a GDrive project folder
/update-claude-md Refresh the framework section of CLAUDE.md
```

### Check status

```
claude-deel-treasury status
```

---

## Part 6 — Troubleshooting

### "ps1 is not digitally signed" (Windows)

```
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### "Unauthorized: DEEL_TREASURY token missing"

```
claude-deel-treasury auth
```

If not set:
- Windows: `[System.Environment]::SetEnvironmentVariable("DEEL_TREASURY_TOKEN", "dlt_...", "User")`
- mac/Linux: `export DEEL_TREASURY_TOKEN="dlt_..."` (add to ~/.zshrc)

### "This package requires a newer version"

```
npm install -g claude-deel-treasury@latest
```

### GDrive project folder not found

1. Check folder exists: Knowledge Base / Treasury / FX Team / Projects/<name>
2. Run /scaffold-project inside Claude Code

---

Maintained by Deel Treasury FX Team | package: claude-deel-treasury (npm)
