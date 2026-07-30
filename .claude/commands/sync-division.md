Sync FX Team division knowledge from internal wiki into this project.

Updates wiki-sourced div files only. Division config files (division.md, standards.md, policy.md, etc.) are maintained locally in the repo and are never overwritten.

For project knowledge, use /project-sync instead.

Follow these steps exactly. Do not skip any step.

---

## Step 1 — Read configuration

Read `.claude/registry.json`. Find all entries in `div_files` that have a `wiki_page_id` field.

---

## Step 2 — Sync wiki-sourced div files

For each entry with a `wiki_page_id`:
- Use the Wiki MCP `get_page` tool with the `pageId`
- Convert the returned `render` HTML to clean markdown (strip tags, preserve headings/lists/code blocks)
- Write to `.claude/rules/div/<key>` with this header:
  ```
  # <page title>

  > Source: <wiki_url>
  > Last updated: <updatedAt>

  <converted content>
  ```

Current wiki-sourced div files:
- `fx-rate-mesh.md`      — page ID 7220  (FX rate service: providers, API, monitoring)
- `fxall-integration.md` — page ID 14521 (FXAll integration & v2 bid/ask API)

SAFETY: Write ONLY to `.claude/rules/div/`. Never touch dept/ or project/ files.

---

## Step 3 — Stage changes

```
git add .claude/rules/div/
```

---

## Step 4 — Show diff and auto-commit

```
git diff --cached --stat
```

If there are staged changes, commit automatically (no confirmation needed):
```
docs(knowledge): sync division wiki knowledge — [today's date]
- Wiki files updated: [list]
```

If there are no staged changes, say: "Everything is already up to date."

---

## Step 5 — Confirm

"Division knowledge synced.
- Wiki files updated: [list]"

---

SAFETY RULE: Never fetch or overwrite `.claude/rules/div/` config files (division.md, standards.md, policy.md, fx-hedging-policy.md, fx-hedging-strategy.md) from GDrive. Never touch dept/ or project/ files.
