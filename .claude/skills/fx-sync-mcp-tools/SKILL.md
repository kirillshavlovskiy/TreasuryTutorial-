---
name: fx-sync-mcp-tools
description: Add newly-registered TMS Finance MCP tools to the local catalogue (docs/tms-mcp/tools.md), so it never silently misses a tool the server actually offers. Use when asked to "sync MCP tools", "update the TMS tool catalogue", "refresh the tool descriptions", or at session start when a tool name visible in this session is missing from the catalogue's "Tool name index" — a catalogued name absent from THIS session's tool list is normal (permission-gating) and is not itself a reason to run this. Writes only to docs/tms-mcp/tools.md — it never calls a TMS MCP tool itself, only ToolSearch to read a tool's own schema, and never deletes an entry on an incremental run.
user-invocable: true
allowed-tools: Bash(node *), Bash(ls *), Bash(cat *), Bash(git *), Bash(find *), Read, Write, Edit, Grep, Glob, Agent, ToolSearch
---

# FX Sync MCP Tools

Keep `docs/tms-mcp/tools.md` — the local catalogue of TMS Finance MCP tools — matching what this
session's TMS Finance MCP server actually offers. Nothing else.

---

## Hard rules

1. **Never call a TMS Finance MCP tool.** This skill only reads tool *schemas* — via `ToolSearch`,
   or by reading the `treasury` checkout's source — never a tool's data. Calling a tool is a
   different task, governed by `.claude/rules/project/tms-mcp.md`.
2. **Only catalogue read-only tools with a description and parameters.** A mutating tool
   (`annotations.readOnlyHint` not `true`) gets a name and its required permission in "Mutating
   tools — never call", and nothing else — not in that section, not in "Deep reference". See
   Step 3 for how to tell the two apart, and what to do when you can't.
3. **Write only `docs/tms-mcp/tools.md`.** Never commit, never push, never touch
   `.claude/rules/dept/` or `.claude/rules/div/`.
4. **A failed or partial sync must not silently overwrite a good catalogue.** A half-written file
   looks the same as a complete one to the next reader — it just lies. Stop with `RESULT: SYNC
   FAILED` instead (Step 4).

## Two modes

Default: **incremental** — only reconciles the difference between the catalogue's name index and
the live session's tool list. Cheap, and the normal path.

`/fx-sync-mcp-tools --full` — rebuilds the whole file from scratch. Use this the first time, or
if the catalogue looks structurally broken rather than just behind.

---

## Step 1 — Read the live tool list

Find every tool name in this session's available-tools context whose prefix identifies it as the
TMS Finance MCP server (the same prefix `.claude/rules/project/tms-mcp.md` and prior sessions
have used). Note the prefix and the count.

**No TMS Finance MCP server in this session:** stop.

```
RESULT: SYNC FAILED — no TMS Finance MCP server in this session
```

Do not touch the existing catalogue.

## Step 2 — Diff against the name index

Read `docs/tms-mcp/tools.md` § "Tool name index" (the fenced block right under that heading —
nothing else in the file). Compute:

- `added` — names in the live list, not in the index

That is the **only** set incremental mode computes or acts on. Do **not** compute a `removed` set
from "names in the index but not in the live list" — that comparison is meaningless on its own.
`app/src/mcp/server.ts` registers a tool only for a caller whose `ResourcePermissions` satisfy it
(`docs/tms-mcp/tools.md` § "How to read this file" item 1), so a session with narrower permissions
than whoever ran the last sync will *always* fail to see some registered names — most of them
mutating, since read-only tools tend to need only broad `READ` grants. Treating that absence as
"removed" and deleting it (Step 4 used to do exactly this) would strip real, still-registered
mutating tools out of "Mutating tools — never call" the moment anyone with narrower permissions
ran an incremental sync — shrinking the one section this whole catalogue exists to keep complete,
based on nothing but which caller happened to run the sync. A genuine removal is only detectable
against ground truth — see Step 5.

If `added` is empty:

```
RESULT: NO CHANGE
```

Stop. Do not rewrite the file just to update its date — an unnecessary diff on a generated file
makes real changes harder to spot in review.

`--full` ignores this diff and treats every live name as needing a fresh description — but see
Step 4's `--full` section for why "every live name" is still not the same as "every catalogued
name".

## Step 3 — Classify each tool as read-only or mutating

This is the step that has a real gap, so read it carefully — see also
`docs/tms-mcp/CLAUDE.md` § "Honest gap: how a NEW tool gets classified as read-only".

**If a local `treasury` checkout is available** (try, in order: an explicit path the person
gives you, `TREASURY_REPO`, then the conventional path used in this project's history) — use it
as ground truth:

1. Read `app/src/mcp/lib/registered_tools.ts` to find which tool files are actually registered
   (a file existing under `tools/**` does not mean it's wired in — check the exported array).
2. For each tool you need, read its `export const metadata` block: `name`, `description`,
   `annotations.readOnlyHint`, `requiredPermissions`. Resolve any
   `RESPONSE_TRIMMING_HINT.<key>` reference against `app/src/mcp/lib/trimming_hints.ts` — several
   real tool descriptions end with one of these and are incomplete without it.
3. For each read-only tool going into "Deep reference", read its `export const schema` block for
   parameter names, zod type, `.optional()`/`.default()` (→ not required), and `.describe(...)`.

`.claude/skills/fx-sync-mcp-tools/scripts/mcp-tool-drift.mjs` implements exactly this parsing —
reuse its exported functions (`scanTreasuryRepo`, `parseToolMetadataBlocks`, `resolveDescription`)
rather than re-deriving it, both here and for Step 5.

**If no `treasury` checkout is available:** batch the `added` names into groups of 20. Run up to 4
subagents in parallel (`Agent` tool); each agent makes exactly one `ToolSearch` call with
`select:<its 20 names>`, writes the returned `{name, description, parameters}` for each as JSON to
a scratchpad file, and returns only the file path and count — never the full JSON inline, or the
main session's context grows by the very amount this batching exists to avoid. An agent must
never call the tool itself, only `ToolSearch`.

**`ToolSearch` cannot tell you if a tool is read-only** — its result has no
`annotations.readOnlyHint`, only `description` and `parameters`. So without a `treasury` checkout:

- A name already in the catalogue keeps its last-known classification (do not re-derive it from
  `ToolSearch` and possibly downgrade a correct "mutating" to an unverified "read-only").
- A genuinely new name goes into a third bucket, **"Unclassified — verify before calling"**: name
  and description only, explicitly marked as neither confirmed read-only nor confirmed mutating.
  Never place an unclassified tool in "Read-only catalogue" or "Deep reference". This is slower to
  fully populate than assuming read-only, and that is the point — an unverified guess here is a
  safety issue, not just an inconvenience.

## Step 4 — Update the file

Read the current `docs/tms-mcp/tools.md` in full (needed regardless of mode, to preserve
everything the diff didn't touch).

**Incremental:** for each `added` tool, insert it into "Tool name index" (sorted) and into either
"Read-only catalogue by domain" + "Deep reference" (if read-only and classified), "Mutating tools
— never call" (if mutating), or "Unclassified — verify before calling" (if undetermined — see
Step 3). Update the header's counts and date. **Never delete an existing entry in incremental
mode** — see Step 2 for why an entry the session can't see is not evidence it should be removed.

The only source that can legitimately signal a real removal is Step 5's treasury-checkout scan
(its "In catalogue, not in repo" list) — and even then, don't delete automatically. Name it in the
summary as a candidate removal for the person to confirm, the same way Step 4's "anything went
wrong" path below asks a person rather than guessing. If they confirm it, that's a `--full` rerun
or a manual edit, not an automatic side effect of a routine incremental sync.

**`--full`:** rebuild every section from the classified tool set. If a `treasury` checkout is
available, the full 219-name registered set from it (Step 3) is the composition source — not this
session's session-visible names, which by construction are a permission-filtered subset and would
silently shrink the catalogue on every `--full` run by whoever has the narrowest permissions.
Without a checkout, do not attempt to reconstruct entries this session cannot see either: start
from the **existing** catalogue's classified entries, add every name the session sees that is not
already there, and leave everything else as it was — `--full` without a checkout is "recheck and
reformat what's already known plus what's new," not "rebuild from what this one session can see."

Keep the file's structure exactly as it is now — "Tool name index" first (a fenced block, one name
per line), then "How to read this file", "Read-only catalogue by domain" (grouped,
`| Tool | Permission | Description |` tables), "Mutating tools — never call" (name + permission
only, grouped), "Unclassified — verify before calling" (only if non-empty), "Deep reference" (full
parameter tables, read-only tools in the domains this project actually uses — check
`docs/tms-mcp/CLAUDE.md`'s task-to-tool map for which domains those are before assuming it's still
the same list), "Deployment drift" (Step 5's output). A description containing a literal `|` must
be escaped as `\|` so it doesn't break its table row — `mcp-tool-drift.mjs`'s `unescapeTableCell`
is the exact inverse, used when the drift script reads a row back.

**Anything went wrong** (a classification is ambiguous and unresolvable, a scratchpad file from
Step 3 is missing or empty, the existing file doesn't parse the way Step 2 expects): stop.

```
RESULT: SYNC FAILED — <what specifically went wrong>
```

Leave the existing file untouched. A stale catalogue that is honestly stale is better than one
silently overwritten with a hole in it.

## Step 5 — Cross-check against a `treasury` checkout (optional, always attempt)

```bash
node .claude/skills/fx-sync-mcp-tools/scripts/mcp-tool-drift.mjs
```

Pass `--repo <path>` if the checkout isn't at the script's default location. Replace the
"Deployment drift" section with this run's output verbatim (inside a fenced block), plus one line
naming today's date and which `treasury` ref/branch was compared. No checkout found is not a
failure — the script prints `RESULT: SKIPPED`; write that into "Deployment drift" as-is.

## Step 6 — Report

Last line, always one of:

```
RESULT: SYNCED — +<added> −<removed> tools, <n> drift item(s)
RESULT: NO CHANGE
RESULT: SYNC FAILED — <reason>
```

Before that line, say in plain language what changed — new tool names, anything that moved to
"Unclassified", anything removed. If nothing changed, say so in one sentence and stop; do not
restate the whole catalogue back to the person.

---

## Anti-patterns

- **Do not assume a tool is read-only because it "sounds like" a lookup.** `list_finance_workflows`
  and `list_currencies` are lookups; `ns_create_vendor_bill` also starts with a verb that isn't
  `create` in every reader's head until they actually read it. Check the flag or checkout; don't
  guess from the name.
- **Do not put a mutating tool's parameters anywhere in the file.** This includes "Deep reference"
  — it is filtered to read-only tools by design, not by accident. A past draft of this catalogue
  briefly listed `tms_create_financial_account`'s full parameter table, including
  `accountNumber`/`routingNumber`/`iban`/`swift`/`aba` field names, before this rule was written
  down. Don't repeat that.
- **Do not skip the `RESPONSE_TRIMMING_HINT` resolution step when reading from a `treasury`
  checkout.** Several real tool descriptions concatenate one of these at the end and are
  incomplete without it — this was found and fixed while building this catalogue the first time.
- **Do not compare a catalogue description against a `treasury` scan without normalizing
  whitespace first.** A multi-paragraph description is flattened to one line for the markdown
  table; comparing it raw against the checkout's un-flattened version reports every one of those
  tools as changed on every run, with zero actual drift.
