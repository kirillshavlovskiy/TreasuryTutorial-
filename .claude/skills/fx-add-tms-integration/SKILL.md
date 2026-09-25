---
name: fx-add-tms-integration
description: Work out which TMS Finance MCP tool can back a new capability in this app, prove that tool is read-only, and confirm with one minimum-scope call that it actually returns the fields the feature needs. Use when asked to "add FX rates from the treasury", "pull live notional pool balances instead of the static snapshot", "show FX order status from TMS", "is there a TMS tool for this", or before wiring any new Treasury data into a screen or a calculation — it reuses the catalogue in docs/tms-mcp/tools.md and the /fx-sync-mcp-tools skill rather than re-reading tool schemas itself, and stops outright when only a mutating tool could satisfy the request, because this project never writes to Treasury. Produces a validated tool recommendation for fx-plan-task; it never writes the integration code.
user-invocable: true
allowed-tools: Bash(node *), Bash(grep *), Read, Grep, Agent, ToolSearch, AskUserQuestion
---

# FX Add TMS Integration

Answer one question: which TMS Finance MCP tool, if any, should back this capability, and is it
safe and correct to use. Print the answer. Do not write the integration.

When the first of this app's two existing integrations was built, two tools that looked right from
their descriptions turned out not to carry the field the book needed. Finding that out before any
code is written is what this skill is for.

## Boundaries — these are not negotiable

1. **A mutating tool is never the answer.** Not with care, not behind a flag, not "just this
   once", and never via a read-only tool that reproduces the write in our own database. Stop —
   see Step 4. Source: `fx-review/check-financial.md` section 7,
   `.claude/rules/project/tms-mcp.md`.
2. **No value a tool returns is ever written down.** Not in the recommendation, not in a plan, not
   in a fixture, not in a file, not in a commit message, not in a log. The *shape* of a response is
   the finding; the numbers in it are RESTRICTED data. Source: `fx-review/check-financial.md`
   section 6, `.claude/rules/dept/compliance.md`.
3. **This skill writes no code and no file.** It has no `Write` and no `Edit` on purpose. The
   output is a printed recommendation for `fx-plan-task`.
4. **Never classify a tool as read-only by guessing.** Only the catalogue's own classification, or
   a `treasury` checkout's `annotations.readOnlyHint`, counts. See Step 4.

---

## Step 1 — Turn the request into a field list

"I need to fetch FX rates for something" is a perfectly good way to start, and it is not yet a
requirement. Turning it into one is this skill's job, not the person's. Do not expect field names,
granularity or freshness to arrive with the request — nobody has to know the API to ask. Work out
which of the five items below the request already answers, and ask about the rest in plain
language, one question at a time (`AskUserQuestion`), before searching. Then note in your reply:

- **Which numbers**, by name. Not "rates" — "the 1-month forward and the spot for 14 pairs".
- **Granularity**: per currency, per account, per order, per day.
- **Freshness**: latest, a specific date, or a range.
- **Where it lands**: a number on a screen, or an input to a calculation that sizes a position.
- **What it replaces**: a hardcoded table (`CURRENCY_PARAMS` in `lib/fx-buffer.ts`), a static
  snapshot, or nothing.

Ask in the person's terms, not the catalogue's: "which currencies, and against what?" rather than
"which pairs"; "today's rate, or a past date?" rather than "freshness"; "is this for a screen, or
does a calculation use it?" rather than "where it lands"; "is this new, or should it take over from
something already on the page?" rather than "what it replaces". A person who doesn't know the last
one is telling you something real — default it to "nothing, this is new" and say so back to them,
rather than pressing for an answer they don't have.

Do not stop asking until all five are answered or explicitly defaulted — not just enough to name a
tool. The first two decide whether a tool is a *match* (a description that fits but a response
missing a required field is not a match); the last two decide what Step 6 requires of the plan
(a calculation gets `Decimal.js` and audit logging, a screen does not; a replacement needs a
degrade-gracefully story, something new does not) — skipping them here means guessing them in
Step 6 instead.

## Step 2 — Search the local catalogue, in this order

The catalogue is `docs/tms-mcp/tools.md`. It is generated — never hand-edit it. Read its
"How to read this file" section once before trusting a hit.

Print the section boundaries first, so you can tell which section each grep hit landed in:

```bash
grep -n "^## " docs/tms-mcp/tools.md
```

Then search, curated map first:

```bash
grep -n -i "<keyword>" docs/tms-mcp/CLAUDE.md
grep -n -i "<keyword>" docs/tms-mcp/tools.md
```

Search two or three keywords, not one — a domain word ("notional pool"), the field name ("balance",
"forward", "cursor"), and the business verb ("hedge", "settle").

| Stage | Where | What it tells you | What it cannot tell you |
|---|---|---|---|
| 1 | `docs/tms-mcp/CLAUDE.md` § "Task → tool map" | the tool this project has already chosen for a known need, and whether it is live on dev today | anything outside the eleven needs listed there |
| 2 | `tools.md` § "Read-only catalogue by domain" | full description and required permission — whether the tool plausibly satisfies the field list | whether the response really carries those fields |
| 3 | `tools.md` § "Deep reference" | exact parameter table, for the six domains this project uses; a `####` heading tagged **[PENDING — PR #14082, not yet deployed]** marks a read-only tool that is reviewed but not on the server yet | nothing for a read-only tool outside those domains — get its parameters from `ToolSearch` instead |
| 4 | `tools.md` § "Mutating tools — never call" | that a tool exists and is off-limits | whether it would satisfy the need — no description is recorded there, by design |
| 5 | `tools.md` § "Deployment drift" | the dated comparison against dev and against PR #14082's branch — a bare list of names in "In repo, not in catalogue" | when they will deploy; it carries no tags and no descriptions |

A hit in stage 4 can only ever **rule a tool out**. It carries a name and a permission and nothing
else, so you cannot conclude from it that the tool would have worked — and you must not go looking
elsewhere for its parameters to find out. Source: `tools.md` § "How to read this file" item 4.

A tool tagged **[PENDING]** is a real, reviewed tool that a live session cannot see yet. It can be
recommended, but Step 5 cannot validate it. Say so.

## Step 3 — Check the live session only for what the catalogue is missing

The catalogue and the session disagree in both directions, and only one direction means anything.
This is already explained — do not re-derive it: read `tools.md` § "How to read this file" item 1
and `.claude/rules/project/tms-mcp.md` § "Session start".

| What you see | What it means | What to do |
|---|---|---|
| a TMS tool name in this session that the catalogue's "Tool name index" does not have | genuinely new — the catalogue has never classified it | run `/fx-sync-mcp-tools`, then redo Step 2 against the updated file |
| a catalogued tool this session cannot see | normal: `requiredPermissions` gate registration per caller | it is still a valid recommendation. Step 5 cannot validate it in this session — record that as unvalidated, never as "removed" or "missing" |
| no TMS Finance MCP server in this session at all | you can finish Steps 2, 4, 6 and 7 from the catalogue | Step 5 does not run. Step 7's last line becomes `RESULT: TOOL FOUND, NOT VALIDATED — <tool>, read-only, no TMS Finance MCP server in this session` |

If Steps 2 and 3 both come up empty, one thing is left to check before concluding TMS cannot do
this. Without a local `treasury` checkout the catalogue can only ever grow by what some session has
actually seen, so a registered tool that no sufficiently-permissioned session ever synced is
invisible to this whole procedure:

```bash
node .claude/skills/fx-sync-mcp-tools/scripts/mcp-tool-drift.mjs
# resolves the checkout as --repo, then $TREASURY_REPO, then the script's default path;
# if that lands on SKIPPED, point it explicitly:
node .claude/skills/fx-sync-mcp-tools/scripts/mcp-tool-drift.mjs --repo <path-to-treasury>
```

The last line of its output is one of four results, and each means something different:

- `RESULT: IN SYNC` — the checkout confirms the catalogue is complete. "No match" is genuinely
  "nothing in TMS backs this".
- `RESULT: DRIFT FOUND` — a name under "In repo, not in catalogue" is a candidate: run
  `/fx-sync-mcp-tools` and redo Step 2.
- `RESULT: SKIPPED` — no checkout was found, so "no match" is honestly "no match in what we can
  see", and the report must say that.
- `RESULT: SCAN FAILED` — the scan never ran. This is **unknown**, never "no match"; say so in the
  report. The same rule already exists for the env-drift script (`decisions.md`: do not treat
  `SCAN FAILED`, or a silent exit, as `IN SYNC`).

## Step 4 — Confirm read-only before any call

Read `docs/tms-mcp/CLAUDE.md` § "Honest gap: how a NEW tool gets classified as read-only" once.
`ToolSearch` returns a description and parameters — it does **not** return
`annotations.readOnlyHint`, so it can never settle this question.

| Where the tool sits | Verdict |
|---|---|
| "Read-only catalogue by domain" | read-only, confirmed. Proceed to Step 5 |
| a `####` heading under "Deep reference" tagged **[PENDING — PR #14082, not yet deployed]** | read-only, confirmed — the catalogue header counts these as read-only tools staged on that PR. Recommend it, but Step 5 cannot run against it yet: report it as found, not validated |
| "Mutating tools — never call" | **hard stop** — see below |
| "Unclassified — verify before calling", or seen live and not in the catalogue at all | **not** read-only. Do not call it. Resolve it first: `/fx-sync-mcp-tools` against a `treasury` checkout reads the real flag. With no checkout, it stays unclassified and unusable — stop and say so. (The "Unclassified" section exists only when non-empty — its absence from the file is normal, not a broken catalogue) |

Never infer the answer from the verb in the name, or from the permission string.
`ap_preview_approval_rules` sounds like it acts and its own description ends "Read-only — no
approval or bill state is written"; `download_bank_statement_pdf` sounds like a read and requires
only `financial_accounts: 'READ'`, yet the catalogue lists it under "Mutating tools — never call".
Only the section a tool sits in counts.

**If two authoritative sources in this repo disagree on a tool's classification, treat it the
same as "Unclassified" — stop, do not pick a side.** `.claude/skills/fx-review/check-financial.md`
section 7 lists `enrich_invoice` as a tool that writes; `docs/tms-mcp/tools.md` catalogues it as
read-only. Do not resolve this yourself and do not call `enrich_invoice` (or any tool with the same
kind of conflict) on the strength of one source outranking the other — verify the real
`annotations.readOnlyHint` against a `treasury` checkout, or ask a person, before proceeding. This
mirrors Boundary 4 and the "fail closed" rule in root `CLAUDE.md` § Security: a classification you
are not sure of is not a classification. (This specific conflict is worth its own follow-up —
suggest flagging it, do not silently work around it here.)

**The hard stop.** When the only tool that could satisfy the request mutates Treasury, stop there.
Do not design around it. Say which tool, which permission it requires, and that this project reads
from Treasury and writes only to its own database. Then print:

```
RESULT: NO READ-ONLY TOOL — <capability>; only <tool name> could do it, and it mutates Treasury
```

**A read-only tool that gets part of the way is worth reporting — as a different capability, never
as a substitute.** Most requests phrased as a write are really a read: "book the hedge" from this
app is refused, but `fx_order_search` → `fx_order_detail` shows what was booked, and
`fx_hedging_controls` shows the rules that would have applied. Report it under its own heading,
name the gap in one sentence ("this shows orders already booked in TMS; it does not book one"), and
leave the verdict on the original request at no. Do not merge the two into a line that reads as if
the request was satisfied, and do not offer a read-then-write-locally version of the same
capability — that is the workaround this step exists to refuse.

## Step 5 — Validate the shape with one call, never the values

A description is not evidence. `lib/treasury/snapshot.ts`'s header records why: `check_all_rails`
and `fx_pl_report` both read like they would supply the non-NP cash and the net FX position, and
both were ruled out "confirmed by direct calls against the connected Treasury MCP, not assumed" —
one mixes dozens of unrelated account uses, the other returns cumulative P&L rather than a
position. Either would have produced a plausible-looking wrong number in the book.

So the call happens. What makes it safe is that it is scoped to answer a structural question and
its result is never retained.

1. **Minimum scope.** One currency pair, one account, one day. `limit: 1` wherever the tool takes a
   `limit`. Never a whole book, never a date range wider than one day.
2. **Project down to the fields you are testing.** Every tool accepts `fields` (allowlist) and
   `omit` (denylist), dotted-path, applied server-side — `docs/tms-mcp/CLAUDE.md` §
   "Response conventions". Pass `fields` naming exactly the fields from Step 1. Do not fetch the
   full payload and filter afterwards; the question is what enters the session at all.
3. **Prefer the dev server.** The catalogue reflects `treasury.deel.training`, not production
   (`tools.md` § "How to read this file" item 2). Check which server the app is pointed at:

   ```bash
   grep TREASURY_MCP_URL .env.local 2>/dev/null || grep TREASURY_MCP_URL .env.example
   ```

   `treasury.deel.training` → dev, proceed. Anything else — including `treasury.deel.network`,
   which is production and what `.env.example` ships with — means rules 1, 2 and 4 apply harder;
   they do not become optional. The session's own MCP connector can differ from the app's URL; if
   you cannot tell which server it reaches, assume production.
4. **Run the call in a sub-agent that reports shape only.** Same goal as the containment in
   `fx-sync-mcp-tools` Step 3 — the payload never enters this session — but the opposite
   mechanism: there, the agents write the JSON to a scratchpad file and return its path; here, the
   agent writes it **nowhere**. `subagent_type: general-purpose`. Give it the tool name, the exact
   arguments, and the field list. It returns only:

   - each requested field: present or absent
   - the JSON type of each, and for a number **whether it arrived as a string or a number** — this
     matters: `investment_revenue_summary` returns `balance` as a string, which is why
     `snapshot.ts` parses it with `new Decimal(row.balance)`
   - the row count, and whether `nextCursor` was set
   - whether `summary` / `followUp` were present
   - whether a date field and a provider/source field are present at all — a rate without both is
     unusable here (`.claude/rules/div/standards.md` for the timestamp; root `CLAUDE.md` §
     "Financial Data Handling" and `docs/tms-mcp/CLAUDE.md` hard rule 5 for the provider). For a
     date, report only its format ("YYYY-MM-DD" vs a full timestamp), never the date itself. For
     any enum-like field — provider, source, status — report only present / absent / null, never
     the member value

   It must not quote a value, must not include an example row, and must not write the payload to a
   file. Honest limitation: the `Agent` tool cannot restrict a sub-agent's tools, so this
   containment holds only because the sub-agent follows the prompt — it is not technically
   enforced. This is not a review, so the Opus-5-minimum rule in `.claude/skills/README.md` does
   not apply to it. The `Agent` tool has no `effort` parameter — do not claim one was set.
5. **Treat the result as ephemeral.** Read the shape report and stop. "One row came back with
   `rate` as a number and `date` populated" is the finding. "EUR/USD was 1.0842" is not a finding,
   and writing it into the recommendation is a section 6 breach.
6. **A failure is a result too.** A permission denial or an unavailable tool is worth reporting, and
   its message is safe to quote: Treasury's own `errorMessage()` strips infra detail before a tool
   error reaches the client — see the comment in `lib/treasury/fx-rates.ts` around the
   `fx_rate_lookup` catch block.

**Honest gap — how the one call gets approved.** A TMS tool's name carries a server-id prefix
(`mcp__<uuid>__<tool_name>`) that belongs to whoever's MCP connector is attached, so it cannot be
listed in `allowed-tools`: a literal name would be wrong for any other clone of this repo or any
other connection, whether or not it also changes between sessions. This skill therefore cannot
pre-authorize the dry-run. In practice the harness prompts and the person approves that single
call; a sub-agent inherits this session's permissions, so the prompt still reaches them. Approve
the one call — never ask for a blanket allow of the whole TMS server to get past a prompt. If no
prompt can be shown (a background or non-interactive session), Step 5 does not run: Step 7's last
line becomes `RESULT: TOOL FOUND, NOT VALIDATED — <tool>, read-only, no approval prompt available
in this session`, and say the shape is unconfirmed. Do not retry under another tool name.

## Step 6 — Work out what the capability costs beyond the call

These are requirements for the plan, not work to do here.

| If the new data… | Then the plan must carry |
|---|---|
| drives a calculation that sizes or decides a position | `Decimal.js` on anything computed from the response, never native float (`docs/tms-mcp/CLAUDE.md` hard rule 6); the *decision* logged, not just the result (`check-financial.md` section 3); the approval thresholds in `.claude/rules/div/fx-hedging-policy.md` as a hard stop in code, not a warning (`check-financial.md` section 4) |
| is only displayed | the same leakage rules, and nothing else from the row above |
| is a rate or price | its `date` and its provider carried with it, all the way to wherever it is compared or stored (`.claude/rules/div/standards.md`). `fx_rate_lookup` returns `provider` only after PR #14082 — if that is not deployed yet, say so |
| would be persisted | the storage decision from `check-database.md` section 1 — store nothing, an aggregate, or raw with a written reason. Default is nothing: neither existing call site caches or keeps a copy (`snapshot.ts` overlays onto the static book per request; `fx-rates.ts` surfaces the response as-is and merges onto nothing) |
| is a live number that `fx-pre-push` Step 8 will need verified by hand | that number comes from an independently sourced figure or from the static baseline being replaced — never from the validated call's own output, which Step 5 rule 5 discards |
| replaces a static value on a screen | an honest degradation path — the `not_connected` / `live` / `reauth_required` / `error` status union both existing call sites return, never a throw into a page render and never a static value rendered as live |
| needs new configuration | `.env.example` **and** the README Environment Variables table in the same commit. `TREASURY_MCP_URL` plus the existing token store already cover a new tool on the same server, so usually nothing is needed |

## Step 7 — Print the handoff

Print these, in this order. Nothing here is written to a file.

1. **Capability** — one plain sentence in the person's own words, so they can confirm it is what
   they asked for, then the field list from Step 1.
2. **Tool** — name, and its required permission exactly as the catalogue row gives it.
3. **Tools rejected** — each one considered and not chosen: its name, which catalogue section it
   was found in, and one sentence on why it did not fit (wrong granularity, a required field
   absent from the shape report, still pending deployment, mutating). `fx-plan-task` Step 6
   requires the rejected alternative with a reason; do not make it redo this work.
4. **The call that was validated** — tool name, the full argument object including the `fields`
   projection, and whether it was actually run or not.
5. **Shape report** — the five bullets from Step 5 rule 4. Field names and types only.
6. **Precedent to follow** — by path:
   - `lib/treasury/mcp-client.ts` — `connectTreasuryMcpClient`, and `parseToolResult` at line 89
     for the error shape. Match it; do not invent a second one.
   - `lib/treasury/fx-rates.ts` — one connection per call, a zod schema that is deliberately
     non-strict so the `summary`/`followUp` envelope passes through, a status union, and a function
     that never throws.
   - `lib/treasury/snapshot.ts` — static fallback carrying a status and an `errorMessage`,
     `Decimal` over a string balance, and a refusal to sum a paginated response when `nextCursor`
     is set.
   - `getValidTreasuryAccessToken` in `lib/treasury/token-store.ts` — where the credential comes
     from. Never a new token path.
7. **Response conventions the implementer needs** — envelope, `fields`/`omit` projection, cursor
   pagination via `nextCursor`/`afterCursor`, error shape. Point at `docs/tms-mcp/CLAUDE.md` §
   "Response conventions"; do not restate it.
8. **The bar** — what Step 6 produced.
9. **What is not validated, and why** — pending deployment, permission-gated in this session, no
   prompt available. Never leave this blank; write "nothing outstanding" if that is true.

Then two follow-ups, named so neither goes missing:

- **`docs/tms-mcp/CLAUDE.md` needs updating when the integration lands** — its "Task → tool map"
  and its "it calls the TMS Finance MCP server in exactly two places today" sentence both go stale
  the moment a third call site exists. That file is hand-maintained (unlike the generated
  `tools.md`). It is the job of whoever implements this, in the same pull request. List it in the
  handoff as a file the plan must change. Not this skill's job — nothing is true yet.
- **A first-of-its-kind integration is usually worth a decision entry.** Which tool, which
  alternative was rejected and why, whether anything is stored, and the freshness and fallback
  contract. Suggest `fx-record-decision` after it lands; never invoke it here — it writes only
  after the person explicitly confirms. A third call site of the same shape as the first two is not
  a new decision.

Last line, always one of:

```
RESULT: TOOL VALIDATED — <tool>, read-only, shape confirmed
RESULT: TOOL FOUND, NOT VALIDATED — <tool>, read-only, <why the call could not run>
RESULT: NO READ-ONLY TOOL — <capability>; only <tool name> could do it, and it mutates Treasury
RESULT: NO MATCH — nothing in TMS backs <capability>
```

Then hand over:

> Next step: run `fx-plan-task` with this recommendation. It produces the plan, `fx-implement`
> writes the code, and `fx-ship` reviews it and writes its tests once you are happy with it.

This skill does not implement. If the person asks you to just wire it up, say that `fx-plan-task`
and then `fx-implement` are the skills for that, with `fx-ship` at the end.

---

## Anti-patterns

- **Do not conclude a mutating tool would be fine if handled carefully.** There is no exception and
  no override. Source: `fx-review/check-financial.md` section 7.
- **Do not read a match out of "Mutating tools — never call".** That section carries no
  descriptions, so it can rule a tool out and nothing more — and going elsewhere for the parameters
  it deliberately omits defeats the reason they are omitted. Source: `docs/tms-mcp/tools.md` §
  "How to read this file" item 4.
- **Do not treat a catalogued tool this session cannot see as removed or missing.** Registration is
  per-caller and permission-gated; a narrower session routinely sees fewer names. Source:
  `.claude/rules/project/tms-mcp.md` § "Session start", 2026-09-02 catalogue header.
- **Do not guess read-only from the tool's name, and do not accept `ToolSearch` as evidence of
  it.** `ToolSearch` returns no `annotations.readOnlyHint`. Source:
  `docs/tms-mcp/CLAUDE.md` § "Honest gap"; `fx-sync-mcp-tools/SKILL.md` anti-pattern 1.
- **Do not recommend a tool on its description alone.** `check_all_rails` and `fx_pl_report` both
  read like they fit the cash and net-position fields and neither does. Source:
  `lib/treasury/snapshot.ts` header comment.
- **Do not fetch a full payload and trim it locally.** `fields`/`omit` are applied server-side;
  local filtering still pulled the whole response into the session. Source:
  `docs/tms-mcp/CLAUDE.md` § "Response conventions".
- **Do not quote, paste, or store a returned value** — not in the handoff, a plan, a fixture, or a
  commit message. A test fixture is invented from the shape report. Source:
  `fx-review/check-financial.md` section 6; `CLAUDE.md` → "Test fixtures must satisfy the real
  type".
- **Do not ask for a blanket allow of the TMS MCP server** to get one dry-run call approved.
- **Do not build a fallback that renders a static value as live.** Both existing call sites return
  a status saying which it is. Source: `lib/treasury/snapshot.ts`, `lib/treasury/fx-rates.ts`.
- **Do not write the integration here.** This skill has no `Write` and no `Edit`, deliberately.
