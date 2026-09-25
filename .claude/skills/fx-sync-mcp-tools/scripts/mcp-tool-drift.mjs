#!/usr/bin/env node
/**
 * TMS Finance MCP tool catalogue drift check.
 *
 * docs/tms-mcp/tools.md is a generated snapshot of the TMS Finance MCP tool list, as visible to
 * whoever last ran /fx-sync-mcp-tools. This script has two independent jobs, selected by flag:
 *
 *   --staleness   Cheap, read-only summary of the catalogue's age and size, for the SessionStart
 *                 hook. Never touches the treasury checkout. Always exits 0.
 *
 *   (default)     Compare the catalogue against a local checkout of the `treasury` repo (the
 *                 source of the MCP server) and report where they disagree.
 *
 * Usage:
 *   node .claude/skills/fx-sync-mcp-tools/scripts/mcp-tool-drift.mjs --staleness
 *   node .claude/skills/fx-sync-mcp-tools/scripts/mcp-tool-drift.mjs
 *   node .claude/skills/fx-sync-mcp-tools/scripts/mcp-tool-drift.mjs --repo /path/to/treasury
 *   node .claude/skills/fx-sync-mcp-tools/scripts/mcp-tool-drift.mjs --strict   # exit 1 on drift
 *
 * Default exit code is 0 even when drift is found, for the same reason env-drift.mjs does this:
 * "repo ahead of deployed dev" is the normal state while a PR is in flight, not a failure.
 *
 * What this script CANNOT see: whether a tool is actually reachable from *this* session — that
 * depends on the caller's Treasury permissions, resolved at MCP-server registration time
 * (app/src/mcp/server.ts filters registeredFinanceToolModules by ResourcePermissions). A tool
 * absent from the live session's tool list may still exist and simply be permission-gated for
 * that caller. This script only compares the generated catalogue against the treasury checkout's
 * *registered* tool set — it never talks to a live MCP server itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Default location of the `treasury` checkout used as the source of truth for tool composition.
 * Overridable with --repo or TREASURY_REPO, because a clone of this repository has no reason to
 * also have `treasury` checked out at this exact path — the skill must degrade to SKIPPED, not
 * fail, when it is absent. See decisions.md (GL-926): skills in this repo must be self-contained.
 */
const DEFAULT_TREASURY_REPO = '/Users/vviital/projects/treasury';

const REGISTERED_TOOLS_RELATIVE_PATH = 'app/src/mcp/lib/registered_tools.ts';
const TRIMMING_HINTS_RELATIVE_PATH = 'app/src/mcp/lib/trimming_hints.ts';

const CATALOGUE_RELATIVE_PATH = 'docs/tms-mcp/tools.md';

/** Walk up from this file until a directory containing package.json is found. */
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function readIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse a --flag value CLI-style: `--name value` or `--name=value`. Returns null if absent.
 *
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | null}
 */
export function getFlagValue(argv, name) {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  return null;
}

/**
 * Resolve the treasury checkout path: --repo, then TREASURY_REPO, then the default.
 *
 * @param {string[]} argv
 * @param {{TREASURY_REPO?: string}} env - only TREASURY_REPO is read; typed narrowly (rather than
 *   NodeJS.ProcessEnv) so a test can pass a minimal fixture instead of fabricating a full
 *   realistic environment (NODE_ENV etc.) it doesn't need. process.env itself still satisfies
 *   this structurally at the real call site.
 * @returns {string}
 */
export function resolveTreasuryRepoPath(argv, env) {
  return getFlagValue(argv, 'repo') ?? env.TREASURY_REPO ?? DEFAULT_TREASURY_REPO;
}

// ── Catalogue parsing (docs/tms-mcp/tools.md) ────────────────────────────────────────────────

/**
 * Pull the "Tool name index" fenced block out of the catalogue: one tool name per line, inside
 * a ``` code fence directly under the "## Tool name index" heading. This is the ONLY thing the
 * --staleness path and the session-start comparison rule need to read — never the full file —
 * which is the entire reason the index exists as a separate block. See decisions.md.
 *
 * @param {string} markdown
 * @returns {string[]} sorted, unique
 */
export function parseCatalogueNameIndex(markdown) {
  const headingIdx = markdown.indexOf('## Tool name index');
  if (headingIdx === -1) return [];
  const afterHeading = markdown.slice(headingIdx);
  const fenceMatch = /```[^\n]*\n([\s\S]*?)```/.exec(afterHeading);
  if (!fenceMatch) return [];
  const names = fenceMatch[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /^[a-z][a-z0-9_]*$/.test(line));
  return [...new Set(names)].sort();
}

/**
 * Pull the catalogue's own header line — "> Generated by ... on YYYY-MM-DD ..." — and extract the
 * generation date, plus the read-only/mutating/registered counts from the summary line beneath it.
 *
 * @param {string} markdown
 * @returns {{generatedOn: string | null, readOnlyCount: number | null}}
 */
export function parseCatalogueHeader(markdown) {
  const dateMatch = /Generated by \S+ on (\d{4}-\d{2}-\d{2})/.exec(markdown);
  const countMatch = /(\d+)\s+read-only tools catalogued/.exec(markdown);
  return {
    generatedOn: dateMatch ? dateMatch[1] : null,
    readOnlyCount: countMatch ? Number(countMatch[1]) : null,
  };
}

/**
 * Days between an ISO date string and now. Returns null if the date does not parse — callers
 * must treat that as "unknown age", not "0 days old".
 *
 * @param {string} isoDate
 * @param {Date} now
 * @returns {number | null}
 */
export function daysSince(isoDate, now) {
  const then = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(then.getTime())) return null;
  const diffMs = now.getTime() - then.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

// ── treasury checkout parsing (registered_tools.ts + trimming_hints.ts) ─────────────────────

/**
 * Extract the RESPONSE_TRIMMING_HINT map from trimming_hints.ts as a plain key -> string record.
 * Tool descriptions concatenate `RESPONSE_TRIMMING_HINT.<key>` at the end of a string literal —
 * without resolving this, several tool descriptions truncate mid-sentence. See decisions.md
 * (this exact gap was flagged during PR #14082 review prep).
 *
 * Deliberately simple: matches `key: 'value...',` or `key: "value...",` pairs inside the object
 * literal, tolerating string concatenation with `+` across multiple lines. Good enough for a
 * drift *reporter*, which only needs to detect a changed hint, not execute TypeScript.
 *
 * @param {string} sourceText contents of trimming_hints.ts
 * @returns {Record<string, string>}
 */
export function parseTrimmingHints(sourceText) {
  const hints = {};
  const objMatch = /RESPONSE_TRIMMING_HINT\s*=\s*{([\s\S]*?)}\s*as const/.exec(sourceText);
  if (!objMatch) return hints;
  const body = objMatch[1];
  // Split on a key: at the start of a line (after trimming) to isolate each entry, since values
  // can span multiple concatenated string-literal lines. Backtick is included in the value
  // alternation alongside quotes so a hint written as a template literal is captured at all —
  // without it, the outer pattern doesn't recognize the value as a value, so the whole entry
  // (not just its backtick portion) fails to match.
  const entryPattern = /(\w+):\s*((?:'[^']*'|"[^"]*"|`[^`]*`|\s|\+)+),?/g;
  let match;
  while ((match = entryPattern.exec(body)) !== null) {
    const key = match[1];
    const rawValue = match[2];
    const joined = [...rawValue.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)]
      .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
      .join('');
    if (joined.length > 0) hints[key] = joined;
  }
  return hints;
}

/**
 * Resolve a tool's raw `description:` field text into its effective description, replacing every
 * `RESPONSE_TRIMMING_HINT.<key>` reference — interpolated (`${...}`) or bare (`+`-concatenated) —
 * with the resolved hint text. An unknown key resolves to nothing and is silently dropped, not
 * left visible as a literal placeholder — this is a display gap when a hint key is renamed, not a
 * correctness one, since `trimming_hints.ts` and every tool file live in the same repo and rename
 * together in the same PR in practice.
 *
 * @param {string} rawDescription concatenated string-literal source (quotes still present)
 * @param {Record<string, string>} hints
 * @returns {string}
 */
export function resolveDescription(rawDescription, hints) {
  // Step 1: resolve a `${RESPONSE_TRIMMING_HINT.key}` template-literal interpolation IN PLACE,
  // before any literal is extracted. At least 8 real tools (ns_get_vendor_bill.ts,
  // ns_search_journal_entries.ts, sf_intercompany_elimination.ts, and others) write the hint this
  // way inside a backtick description rather than by `+`-concatenating it. A plain substitution
  // on the raw source — before the literal-extraction pass below sees it — keeps the hint in its
  // authored position; extracting it as a separate token and appending it to the end (the
  // previous approach) left the literal "${RESPONSE_TRIMMING_HINT.x}" text in place AND glued a
  // duplicate copy of the hint onto the tail, in the wrong spot, on every one of those 8 tools.
  // An unresolved key is dropped silently (matches the bare-reference case in Step 2 below) —
  // this is a display gap, not a data-integrity one, so it does not warrant failing the whole
  // scan over one unrecognized hint key.
  const withInterpolationsResolved = rawDescription.replace(
    /\$\{RESPONSE_TRIMMING_HINT\.(\w+)\}/g,
    (_all, key) => hints[key] ?? ''
  );

  // Step 2: walk string/template literals AND a bare (non-interpolated, `+`-concatenated)
  // RESPONSE_TRIMMING_HINT.<key> reference in the order they appear in the source, appending each
  // resolved piece as it is found. Every real tool file's own `+`-concatenated hint reference sits
  // at the end of its description, but doing this positionally (rather than "join all literals,
  // then append every hint after") is correct even for one that doesn't.
  const tokenPattern = /'([^']*)'|"([^"]*)"|`([^`]*)`|RESPONSE_TRIMMING_HINT\.(\w+)/g;
  let text = '';
  let tokenMatch;
  while ((tokenMatch = tokenPattern.exec(withInterpolationsResolved)) !== null) {
    const [, single, double, backtick, bareHintKey] = tokenMatch;
    if (bareHintKey !== undefined) {
      text += hints[bareHintKey] ?? '';
      continue;
    }
    text += single ?? double ?? backtick ?? '';
  }
  return text.trim();
}

/**
 * Parse every `export const metadata: FinanceToolMetadata = {...}` block from a single tool file's
 * source text. In practice there is exactly one per file, but the function returns an array for
 * uniformity and so a malformed file with zero matches is visibly distinguishable from one match.
 *
 * Deliberately regex-based, not a TypeScript parse: this script is a drift *reporter* for a
 * generated markdown file, not a build step. A tool file that does not match this shape is
 * reported as unparsed rather than crashing the whole scan.
 *
 * @param {string} sourceText
 * @param {Record<string, string>} hints
 * @returns {{name: string, description: string, readOnly: boolean, requiredPermissions: string}[]}
 */
export function parseToolMetadataBlocks(sourceText, hints) {
  const results = [];
  const metaPattern = /export const metadata:\s*FinanceToolMetadata\s*=\s*{([\s\S]*?)^};/gm;
  let metaMatch;
  while ((metaMatch = metaPattern.exec(sourceText)) !== null) {
    const block = metaMatch[1];

    const nameMatch = /name:\s*'([^']+)'|name:\s*"([^"]+)"/.exec(block);
    if (!nameMatch) continue;
    const name = nameMatch[1] ?? nameMatch[2];

    // Bounded by the next known FinanceToolMetadata sibling key, or the block's closing `};`.
    // This list is the type's full field set as of treasury@6fc112bbc (name, title, description,
    // domain, upstream, annotations, requiredPermissions — `name` never follows `description` in
    // a real file, so it is not needed here). A GENERIC "next identifier followed by a colon"
    // boundary was tried and reverted: real tool descriptions are full of colon-labeled prose
    // sub-sections ("USE WHEN: ...", "Returns: ..."), so a generic rule truncates dozens of real
    // descriptions to nothing at the first one. If FinanceToolMetadata ever gains a field, add its
    // name to this list — scanTreasuryRepo's caller can spot-check the resulting description
    // count/emptiness the way this comment's history did, rather than trusting silently.
    const descMatch = /description:\s*([\s\S]*?)(?:,\s*\n\s*(?:requiredPermissions|annotations|domain|upstream|title):|,\s*\n\s*};|\n\s*};)/.exec(
      block
    );
    const description = descMatch ? resolveDescription(descMatch[1], hints) : 'No description provided';

    const readOnly = /readOnlyHint:\s*true/.test(block);

    const permsMatch = /requiredPermissions:\s*{([^}]*)}/.exec(block);
    const requiredPermissions = permsMatch ? permsMatch[1].trim().replace(/\s+/g, ' ') : '';

    results.push({ name, description, readOnly, requiredPermissions });
  }
  return results;
}

/**
 * The list of imported-module identifiers actually wired into the exported
 * `registeredFinanceToolModules` array, in the treasury repo's
 * app/src/mcp/lib/registered_tools.ts.
 *
 * This is the ONLY correct source of "which tool files are live" — a tool file existing under
 * tools/**\/*.ts does not mean it is registered (accounts_payable/ap_bulk_edit_vendor_bills.ts is
 * explicitly `// Disabled: mutation tools deferred for now`), and several helper modules
 * (lazy_deps.ts, shared_context.ts, and similar) export no `metadata` at all. See decisions.md.
 *
 * @param {string} sourceText contents of registered_tools.ts
 * @returns {{importedNames: Set<string>, importPathByName: Map<string, string>}}
 */
export function parseRegisteredModuleImports(sourceText) {
  const importPathByName = new Map();
  const importPattern = /import \* as (\w+) from '(\.\.\/tools\/[^']+)'/g;
  let importMatch;
  while ((importMatch = importPattern.exec(sourceText)) !== null) {
    importPathByName.set(importMatch[1], importMatch[2]);
  }

  const arrayMatch = /registeredFinanceToolModules:\s*ToolModule\[\]\s*=\s*\[([\s\S]*?)\];/.exec(
    sourceText
  );
  if (!arrayMatch) return { importedNames: new Set(), importPathByName };

  const arrayBody = arrayMatch[1];

  // Line-by-line rather than one whole-line regex, so a fully commented-out entry
  // (`// fakeToolDisabled, // Disabled: mutation tools deferred for now`) is excluded entirely
  // while a live entry with a trailing comment (`fakeReadOnlyTool, // still live`) or more than
  // one entry on a line (`m1, m2,`) is still picked up. `registered_tools.ts` is comment-dense
  // (35+ `//` section headers) — a strict "whole line is just `name,`" match silently dropped any
  // entry that didn't fit that exact shape, which would hide a genuinely new registration as
  // "not in the array" rather than surface it as drift.
  const importedNames = new Set();
  for (const rawLine of arrayBody.split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const withoutTrailingComment = trimmed.replace(/\/\/.*$/, '');
    for (const idMatch of withoutTrailingComment.matchAll(/(\w+)/g)) {
      if (importPathByName.has(idMatch[1])) importedNames.add(idMatch[1]);
    }
  }

  return { importedNames, importPathByName };
}

/**
 * Full scan of a treasury checkout: every tool actually registered, with its resolved metadata.
 *
 * Returns null (rather than throwing) when the checkout does not look like the treasury repo —
 * callers turn that into RESULT: SKIPPED, not a crash.
 *
 * @param {string} repoRoot
 * @returns {{name: string, description: string, readOnly: boolean, requiredPermissions: string, sourceFile: string}[] | null}
 */
export function scanTreasuryRepo(repoRoot) {
  const registeredToolsText = readIfPresent(path.join(repoRoot, REGISTERED_TOOLS_RELATIVE_PATH));
  if (registeredToolsText == null) return null;

  const hintsText = readIfPresent(path.join(repoRoot, TRIMMING_HINTS_RELATIVE_PATH)) ?? '';
  const hints = parseTrimmingHints(hintsText);

  const { importedNames, importPathByName } = parseRegisteredModuleImports(registeredToolsText);

  const tools = [];
  for (const moduleName of importedNames) {
    const importPath = importPathByName.get(moduleName);
    if (!importPath) continue;
    const relativeFile = importPath.replace('../tools/', 'app/src/mcp/tools/') + '.ts';
    const fileText = readIfPresent(path.join(repoRoot, relativeFile));
    if (fileText == null) continue;

    for (const tool of parseToolMetadataBlocks(fileText, hints)) {
      tools.push({ ...tool, sourceFile: relativeFile });
    }
  }

  return tools;
}

// ── Comparison ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {string[]} items in a that are not in b
 */
export function missingFrom(a, b) {
  const other = new Set(b);
  return a.filter((item) => !other.has(item));
}

/**
 * Collapse whitespace for description comparison only. The catalogue's markdown table cells
 * are necessarily single-line (a raw newline would break the table), so a multi-paragraph
 * source description (several tools use a backtick template literal with blank-line-separated
 * paragraphs) is flattened when the table is generated. Comparing that flattened form against
 * the repo's raw, newline-preserving description would report every one of those tools as
 * "changed" on every run, even with zero actual drift — this normalizes both sides the same way
 * so only a real content change is reported.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeDescriptionForCompare(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Reverse the `|` -> `\|` escaping the catalogue generator applies so a description containing
 * a literal pipe survives as one markdown table cell. Used only when reading a description back
 * OUT of the table; the generator's own escaping step is separate and not part of this script.
 *
 * @param {string} cellText
 * @returns {string}
 */
export function unescapeTableCell(cellText) {
  return cellText.replace(/\\\|/g, '|');
}

/**
 * Compare a parsed catalogue against a fresh treasury scan.
 *
 * @param {{names: string[], descriptionByName: Map<string, string>, readOnlyByName: Map<string, boolean>}} catalogue
 * @param {{name: string, description: string, readOnly: boolean}[]} repoTools
 */
export function analyseDrift(catalogue, repoTools) {
  const repoNames = repoTools.map((t) => t.name);
  const repoByName = new Map(repoTools.map((t) => [t.name, t]));

  const inRepoNotInCatalogue = missingFrom(repoNames, catalogue.names);
  const inCatalogueNotInRepo = missingFrom(catalogue.names, repoNames);

  const descriptionChanged = [];
  const readOnlyFlagChanged = [];
  for (const name of catalogue.names) {
    const repoTool = repoByName.get(name);
    if (!repoTool) continue;
    const catalogueDescription = catalogue.descriptionByName.get(name);
    if (
      catalogueDescription != null &&
      normalizeDescriptionForCompare(catalogueDescription) !==
        normalizeDescriptionForCompare(repoTool.description)
    ) {
      descriptionChanged.push(name);
    }
    const catalogueReadOnly = catalogue.readOnlyByName.get(name);
    if (catalogueReadOnly != null && catalogueReadOnly !== repoTool.readOnly) {
      readOnlyFlagChanged.push(name);
    }
  }

  return {
    inRepoNotInCatalogue: inRepoNotInCatalogue.sort(),
    inCatalogueNotInRepo: inCatalogueNotInRepo.sort(),
    descriptionChanged: descriptionChanged.sort(),
    readOnlyFlagChanged: readOnlyFlagChanged.sort(),
    get hasDrift() {
      return (
        this.inRepoNotInCatalogue.length > 0 ||
        this.inCatalogueNotInRepo.length > 0 ||
        this.descriptionChanged.length > 0 ||
        this.readOnlyFlagChanged.length > 0
      );
    },
  };
}

function section(title, items, note) {
  if (items.length === 0) return `  ${title}: none\n`;
  const lines = items.map((item) => `      ${item}`).join('\n');
  const suffix = note ? `\n      (${note})` : '';
  return `  ${title}: ${items.length}\n${lines}${suffix}\n`;
}

// ── Entry points ─────────────────────────────────────────────────────────────────────────────

function runStaleness(root) {
  const catalogueText = readIfPresent(path.join(root, CATALOGUE_RELATIVE_PATH));
  if (catalogueText == null) {
    process.stdout.write(
      'TMS MCP catalogue: missing — run /fx-sync-mcp-tools --full\n'
    );
    process.exit(0);
  }

  const { generatedOn, readOnlyCount } = parseCatalogueHeader(catalogueText);
  const nameIndex = parseCatalogueNameIndex(catalogueText);
  const age = generatedOn ? daysSince(generatedOn, new Date()) : null;

  // `nameIndex.length` is a fallback for a header that failed to parse — it is the full index
  // (read-only AND mutating tools), not the read-only count `readOnlyCount` names. Label it
  // generically in that case rather than reusing the "read-only tools" wording, which would
  // overstate the read-only count by the mutating total (55 on the real catalogue).
  const dateLabel = generatedOn ?? 'unknown date';
  const ageLabel = age != null ? ` (${age} day${age === 1 ? '' : 's'} ago)` : '';
  const countPhrase = readOnlyCount != null ? `${readOnlyCount} read-only tools` : `${nameIndex.length} tools`;

  process.stdout.write(
    `TMS MCP catalogue: ${countPhrase}, generated ${dateLabel}${ageLabel}.\n` +
      `Name index: ${CATALOGUE_RELATIVE_PATH} § "Tool name index".\n` +
      'Compare it against the TMS MCP tool names in this session; if they differ, run /fx-sync-mcp-tools.\n'
  );
  process.exit(0);
}

/**
 * Parse the generated catalogue's own content — the "Read-only catalogue" tables and the
 * "Mutating tools" section — into the per-tool `{descriptionByName, readOnlyByName}` shape
 * `analyseDrift` compares against a fresh treasury scan.
 *
 * Extracted as its own pure function so this parsing can be unit-tested directly, without
 * spawning the CLI or touching the filesystem — the class of bug it exists to catch (regex
 * matching bleeding across a line boundary) only shows up with a realistic multi-row, multi-table
 * fixture, which is easiest to write and assert against as a plain string in a test.
 *
 * @param {string} catalogueText
 * @returns {{descriptionByName: Map<string, string>, readOnlyByName: Map<string, boolean>}}
 */
export function parseCatalogueTools(catalogueText) {
  const descriptionByName = new Map();
  const readOnlyByName = new Map();

  // Parse the "Read-only catalogue by domain" table rows: | `name` | permission | description |
  //
  // Scoped to the text BEFORE "## Deep reference", never the whole file. "Deep reference" has its
  // own 4-column `| Param | Type | Required | Description |` tables, and a *parameter* row like
  // `| \`currency\` | string | no | Currency code. |` matches this same 3-group pattern just as
  // well as a real tool row — it fabricates a bogus "descriptionByName" entry keyed by a
  // parameter name (`currency`, `limit`, `date`, …) instead of a tool name. Harmless only by
  // coincidence (no parameter happens to share a name with a real tool today); scoping the scan
  // removes the possibility entirely rather than relying on that coincidence continuing.
  //
  // Matched ONE LINE AT A TIME, not with a whole-file multiline regex. `\s` and `.` both match
  // `\n`, so a whole-file version of this pattern can — when it hits a row with fewer columns
  // than expected, like the 2-column "Mutating tools" table — extend `[^|]*` and the lazy
  // `(.+?)` PAST the end of that short row and into the next line entirely, capturing a bogus
  // "description" scraped from a different tool's row and keying it under the wrong tool name.
  // Found the hard way: it fabricated a "description" for `tms_create_financial_account` out of
  // the following row's content and reported it as real drift. Per-line matching makes that
  // structurally impossible — there is no `\n` inside a single line for `.` or `\s` to cross.
  const textBeforeDeepReference = catalogueText.split(/\n## Deep reference\b/)[0];
  const tableRowPattern = /^\|\s*`([a-z][a-z0-9_]*)`\s*\|[^|]*\|\s*(.+)\s*\|\s*$/;
  for (const line of textBeforeDeepReference.split('\n')) {
    const rowMatch = tableRowPattern.exec(line);
    if (!rowMatch) continue;
    const [, name, description] = rowMatch;
    // A description containing a literal `|` (e.g. sf_query_subsidiary_account_balance's
    // `"trandate" | "posting_period"`) is escaped as `\|` when the table is generated, so the
    // markdown row stays a valid table cell. Reverse that here, or every such tool compares as
    // "changed" forever, purely from the escaping — not a real content difference.
    descriptionByName.set(name, unescapeTableCell(description.trim()));
    readOnlyByName.set(name, true);
  }

  // Parse the "Mutating tools — never call" section: names present there are NOT read-only.
  // `$` (no `m` flag) already matches end-of-string OR the position just before a single trailing
  // newline at the very end of the string — `\n$` in the original lookahead required an EXTRA
  // explicit newline character beyond that, so a catalogue whose mutating section is the last
  // thing in the file, with no following heading, matched nothing and every mutating
  // classification was silently lost (a false "IN SYNC" on all 55, the more dangerous direction
  // of failure). Not triggerable in the real file (Deep reference and Deployment drift always
  // follow), but the boundary should not depend on that ordering staying true.
  const mutatingSectionMatch = /## Mutating tools[\s\S]*?(?=\n## |$)/.exec(catalogueText);
  if (mutatingSectionMatch) {
    const mutatingNamePattern = /`([a-z][a-z0-9_]*)`/g;
    let mutatingMatch;
    while ((mutatingMatch = mutatingNamePattern.exec(mutatingSectionMatch[0])) !== null) {
      readOnlyByName.set(mutatingMatch[1], false);
    }
  }

  return { descriptionByName, readOnlyByName };
}

function runDrift(root, argv) {
  const treasuryRepoPath = resolveTreasuryRepoPath(argv, process.env);

  if (!fs.existsSync(treasuryRepoPath)) {
    process.stdout.write(
      '\nTMS MCP TOOL CATALOGUE DRIFT\n\n' +
        `  RESULT: SKIPPED — treasury checkout not found at ${treasuryRepoPath}\n\n` +
        '  This is not an error. Pass --repo <path> or set TREASURY_REPO to compare against a\n' +
        '  local checkout. Without one, this script cannot verify the catalogue.\n'
    );
    process.exit(0);
  }

  const repoTools = scanTreasuryRepo(treasuryRepoPath);
  if (repoTools == null || repoTools.length === 0) {
    process.stdout.write(
      '\nTMS MCP TOOL CATALOGUE DRIFT\n\n' +
        '  RESULT: SCAN FAILED — could not find or parse registered_tools.ts, or it resolved to\n' +
        '  zero tools.\n\n' +
        `  This is not the same as "no drift". Checked: ${treasuryRepoPath}/${REGISTERED_TOOLS_RELATIVE_PATH}\n` +
        '  Fix the scan (wrong path? repo layout changed?) before trusting a verdict.\n'
    );
    process.exit(1);
  }

  const catalogueText = readIfPresent(path.join(root, CATALOGUE_RELATIVE_PATH));
  if (catalogueText == null) {
    process.stdout.write(
      '\nTMS MCP TOOL CATALOGUE DRIFT\n\n' +
        `  RESULT: SCAN FAILED — ${CATALOGUE_RELATIVE_PATH} does not exist yet. Run ` +
        '/fx-sync-mcp-tools --full first.\n'
    );
    process.exit(1);
  }

  const names = parseCatalogueNameIndex(catalogueText);
  const { descriptionByName, readOnlyByName } = parseCatalogueTools(catalogueText);

  const result = analyseDrift({ names, descriptionByName, readOnlyByName }, repoTools);

  let report = '\nTMS MCP TOOL CATALOGUE DRIFT\n\n';
  report += section(
    'In repo, not in catalogue',
    result.inRepoNotInCatalogue,
    'may be undeployed (PR not merged) or permission-gated for whoever last ran the sync — not necessarily missing'
  );
  report += section(
    'In catalogue, not in repo',
    result.inCatalogueNotInRepo,
    'the treasury checkout may be stale, or the tool was renamed/removed'
  );
  report += section('Description changed', result.descriptionChanged);
  report += section('Read-only flag changed', result.readOnlyFlagChanged);

  report += result.hasDrift ? '\nRESULT: DRIFT FOUND\n' : '\nRESULT: IN SYNC\n';
  process.stdout.write(report);

  if (result.hasDrift && argv.includes('--strict')) {
    process.exit(1);
  }
  process.exit(0);
}

/**
 * Turn an unexpected (uncaught) exception into a safe stdout message and exit code, instead of a
 * raw stack trace on stderr. This script backs `.claude/settings.json`'s SessionStart hook, and
 * `.claude/hooks/protected-paths.mjs`'s own header establishes the principle a hook must follow:
 * a broken guard must fail open, never take down the thing it's attached to. Verified by an
 * independent Opus 5 review: a throwing stand-in script printed a full Node stack trace and
 * exited 1 at session start, before this wrapper existed.
 *
 * `runStaleness`/`runDrift` already call `process.exit` themselves on every expected path
 * (success, SKIPPED, SCAN FAILED) — `process.exit` terminates immediately, so this only ever
 * catches a genuine bug bubbling up, not a normal outcome.
 *
 * @param {unknown} err
 * @param {boolean} isStalenessMode
 * @returns {{message: string, exitCode: number}}
 */
export function formatUnexpectedError(err, isStalenessMode) {
  const reason = err instanceof Error ? err.message : String(err);
  if (isStalenessMode) {
    return {
      message:
        'TMS MCP catalogue: staleness check failed unexpectedly — run /fx-sync-mcp-tools to investigate.\n',
      exitCode: 0,
    };
  }
  return {
    message: `\nTMS MCP TOOL CATALOGUE DRIFT\n\n  RESULT: SCAN FAILED — unexpected error: ${reason}\n`,
    exitCode: 1,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const isStalenessMode = argv.includes('--staleness');

  try {
    const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

    if (isStalenessMode) {
      runStaleness(root);
      return;
    }

    runDrift(root, argv);
  } catch (err) {
    const { message, exitCode } = formatUnexpectedError(err, isStalenessMode);
    process.stdout.write(message);
    process.exit(exitCode);
  }
}

/**
 * Run main() only when this file is executed directly, never when a test imports it.
 *
 * Both sides are realpath'd: Node's ESM loader resolves symlinks in `import.meta.url` but
 * `process.argv[1]` keeps them, so a plain string compare silently fails whenever any component
 * of the project path is a symlink — the SessionStart hook would then print nothing and exit 0,
 * which reads as "catalogue fine" instead of "hook misconfigured".
 */
function realpathOrSelf(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

const invokedAs = process.argv[1] ? realpathOrSelf(path.resolve(process.argv[1])) : '';
if (invokedAs !== '' && invokedAs === realpathOrSelf(fileURLToPath(import.meta.url))) {
  main();
}
