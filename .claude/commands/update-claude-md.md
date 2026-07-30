Update the framework notation section of CLAUDE.md from the canonical template.

Use this when the claude-treasury-framework package has released a new version and you
need to update the instructions for Claude without touching the @import lines or
project-specific content below them.

Follow these steps exactly:

1. Read the current CLAUDE.md in this project.

2. Identify the framework notation section — everything between:
   "# Knowledge framework — read this before anything else"
   and
   "# End of framework notation"
   (both markers are inclusive)

3. Replace that section with the following canonical notation:

---
# Knowledge framework — read this before anything else

This project uses the Treasury three-layer shared knowledge framework.
You must understand the layers before acting on any instruction.

## Layer rules

LAYER 1 — dept/ (department knowledge)
- Owner: department head
- NEVER suggest editing any file under .claude/rules/dept/
- These files are populated by: claude-treasury-framework sync dept
- If dept knowledge seems outdated, tell the user to run: claude-treasury-framework sync dept

LAYER 2 — div/ (division knowledge)
- Owner: team lead
- NEVER suggest editing any file under .claude/rules/div/
- These files are populated by: claude-treasury-framework sync division
- If div knowledge seems outdated, tell the user to run: claude-treasury-framework sync division

LAYER 3 — project/ (project knowledge)
- Owner: all team members
- CAN and SHOULD suggest updates when decisions are made or context changes
- Update these files directly and commit alongside the related code change

## Precedence
dept/ compliance rules always win over all other instructions.
div/ standards apply unless project/ explicitly overrides for this codebase.
project/ context applies to this specific codebase only.

## Sync commands (CLI)
claude-treasury-framework sync dept
claude-treasury-framework sync division
claude-treasury-framework sync division --division <name>

## When project knowledge needs updating
1. Complete the coding task first
2. Say: "I noticed [X] is not captured in project knowledge. Should I update [file]?"
3. Wait for confirmation, then write ONLY to .claude/rules/project/ files
4. Never touch dept/ or div/ files — those are sync-managed

# End of framework notation
---

4. Do NOT modify anything after "# End of framework notation".
   Do NOT touch the @import lines. Do NOT touch project knowledge files.

5. Save CLAUDE.md.

6. Propose this commit:
   git add CLAUDE.md
   git commit -m "docs(claude): update framework notation to latest version"

7. Ask: "Commit this change? (y/n)" and proceed if confirmed.
