#!/usr/bin/env node
/**
 * PreToolUse hook — block edits to platform-managed and sync-managed paths.
 *
 * Wired in .claude/settings.json for Edit | Write | NotebookEdit | MultiEdit.
 *
 * Exit 0  = allow.
 * Exit 2  = block. The reason MUST go to stderr — that is the channel PreToolUse feeds back
 *           to the model on exit 2. stdout is transcript-only, so a message printed there is
 *           silently dropped and the model sees an unexplained refusal. That matters here
 *           because the dropped text is what tells it not to retry through the Write exemption.
 *
 * Anything unexpected FAILS OPEN (exit 0). A hook that throws must never be able
 * to block every edit in the repository — a broken guard is worse than no guard,
 * because it stops all work instead of the work it was meant to stop.
 *
 * ── Matching rules, and why each one is the way it is ────────────────────────
 *
 * NORMALISED: the path is normalised before it is split, so
 * `.claude/rules/project/../dept/x.md` is recognised as `.claude/rules/dept/x.md`.
 * Without this, traversal walks straight past the guard.
 *
 * CASE-INSENSITIVE: macOS ships a case-insensitive filesystem by default, so
 * `dockerfile`, `HELM/values.yaml` and `.GitHub/workflows/ci.yml` all open the real
 * protected files. Comparing exact case leaves every protected path one keystroke
 * from editable. Over-blocking a differently-cased path on a case-sensitive
 * filesystem is harmless; under-blocking one here is not.
 *
 * SEGMENTS, not prefixes: `.claude/worktrees/some-branch/helm/values.yaml` is caught
 * the same as `helm/values.yaml`, while `lib/helmet-config.ts` is not.
 *
 * ── Why the two knowledge layers are handled differently ─────────────────────
 *
 * `.claude/rules/dept/` and `.claude/rules/div/` are read-only mirrors of Google
 * Drive — but `/sync-dept` and `/sync-division` refresh them by WRITING those exact
 * files ("Write to .claude/rules/dept/<filename> (always overwrite)",
 * .claude/commands/sync-dept.md). Blocking every write there would make the layers
 * impossible to update ever again, and the block message would tell the operator to
 * run the very command it just refused.
 *
 * So: in-place edits (Edit, NotebookEdit) are blocked — that is the hand-tweak this
 * guard exists to stop. A full overwrite (Write) is allowed, because that is how the
 * sync commands work. This is deliberately a partial guard. The rest of the defence
 * is elsewhere and does not have this hole: fx-review/classify.md stops the review,
 * fx-plan-task refuses the task, and fx-pre-push step 2 fails on any dept/ or div/
 * path appearing in the diff — so a hand-written overwrite still cannot reach a push.
 *
 * Deployment paths have no legitimate write path at all, so they are blocked for every tool the
 * matcher covers.
 *
 * SCOPE, stated honestly: the settings matcher is Edit | Write | NotebookEdit | MultiEdit. Bash is
 * NOT matched, so `sed -i helm/values.yaml` or `echo > Dockerfile` reaches the file unguarded. This
 * file and .claude/settings.json are also ordinary editable files. The guard stops the accidental
 * edit; it does not stop a determined one, and nothing here enforces anything outside a Claude
 * session. Do not describe it as absolute.
 *
 * Sources: CLAUDE.md -> "What NOT to do" (helm/, .github/, argocd/, values.yaml, Dockerfile);
 *          CLAUDE.md -> knowledge framework layer rules (dept/ and div/ are read-only).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directories that are platform-managed wherever they appear. Compared lower-case. */
const PROTECTED_DIRS = ['helm', 'argocd', '.github'];

/** Exact file names that are platform-managed wherever they appear. Compared lower-case. */
const PROTECTED_FILES = ['values.yaml'];

/** Read-only knowledge layers under .claude/rules/. `project` is deliberately NOT here. */
const READ_ONLY_RULE_LAYERS = ['dept', 'div'];

/**
 * The ONLY tools exempt from the knowledge-layer block — the full-overwrite tools the sync
 * commands use.
 *
 * This is an allowlist on purpose. Listing in-place editors instead would mean any name not on
 * the list — a renamed `Edit`, a future `ApplyPatch` or `StrReplace` — silently gets the
 * exemption, and the layers would quietly stop being protected the day the harness adds a tool.
 * An unknown tool is treated as an in-place edit and blocked.
 */
const FULL_OVERWRITE_TOOLS = new Set(['write']);

const PLATFORM_GUIDANCE =
  'Deployment configuration is owned by the platform team. Changing it can break the ' +
  'deployment pipeline. Ask the platform team instead of editing it here.';

/**
 * Split a path into normalised, lower-cased segments.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function segmentsOf(raw) {
  const forwardSlashed = raw.replace(/\\/g, '/');
  // Resolve `..` and `.` before matching, or traversal defeats the segment check.
  const normalised = path.posix.normalize(forwardSlashed);
  return normalised
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => segment.toLowerCase());
}

/**
 * Decide whether a path may be modified by the given tool.
 *
 * @param {unknown} rawPath
 * @param {unknown} [toolName] the PreToolUse tool_name; defaults to an in-place edit,
 *   which is the stricter reading, so an unknown caller does not get the Write exemption.
 * @returns {{reason: string, guidance: string} | null} null when the edit is allowed.
 */
export function checkPath(rawPath, toolName = 'Edit') {
  if (typeof rawPath !== 'string') return null;

  const trimmed = rawPath.trim();
  if (trimmed === '') return null;

  const segments = segmentsOf(trimmed);
  if (segments.length === 0) return null;

  const base = segments[segments.length - 1];

  // Check every segment, not just the parent directories, so a bare `helm` or `helm/`
  // is caught as well as `helm/values.yaml`. This over-blocks a FILE literally named
  // `helm`, `argocd` or `.github`; none exists, and erring that way is the safe side.
  for (const dir of PROTECTED_DIRS) {
    if (segments.includes(dir)) {
      return { reason: `it is inside ${dir}/, which is managed by the platform`, guidance: PLATFORM_GUIDANCE };
    }
  }

  if (base === 'dockerfile' || base.startsWith('dockerfile.')) {
    return { reason: 'the Dockerfile is managed by the platform', guidance: PLATFORM_GUIDANCE };
  }

  if (PROTECTED_FILES.includes(base)) {
    return { reason: `${base} is managed by the platform`, guidance: PLATFORM_GUIDANCE };
  }

  // .claude/rules/dept/** and .claude/rules/div/** — everything except a full overwrite.
  // Unknown or non-string tool names take the strict path. See the header.
  const isFullOverwrite =
    typeof toolName === 'string' && FULL_OVERWRITE_TOOLS.has(toolName.toLowerCase());

  if (!isFullOverwrite) {
    for (let i = 0; i + 2 < segments.length; i += 1) {
      if (
        segments[i] === '.claude' &&
        segments[i + 1] === 'rules' &&
        READ_ONLY_RULE_LAYERS.includes(segments[i + 2])
      ) {
        const layer = segments[i + 2];
        const command = layer === 'dept' ? '/sync-dept' : '/sync-division';
        return {
          reason: `.claude/rules/${layer}/ is read-only knowledge synced from Google Drive`,
          guidance:
            `Do NOT retry this with Write. Write is exempt only so the sync commands can ` +
            `refresh these files; using it to hand-edit them defeats the guard, and ` +
            `fx-pre-push step 2 will fail on the diff anyway. ` +
            `Local edits here are overwritten by the next sync. If the content is wrong or out ` +
            `of date, ask the owner to change it in Google Drive, then run ${command}. ` +
            `.claude/rules/project/ is the layer this team edits.`,
        };
      }
    }
  }

  return null;
}

/**
 * Pull every path-like value out of a PreToolUse payload.
 *
 * @param {unknown} payload
 * @returns {string[]}
 */
export function extractPaths(payload) {
  if (payload === null || typeof payload !== 'object') return [];
  const toolInput = /** @type {Record<string, unknown>} */ (payload).tool_input;
  if (toolInput === null || typeof toolInput !== 'object') return [];
  const input = /** @type {Record<string, unknown>} */ (toolInput);
  return [input.file_path, input.notebook_path, input.path].filter(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
}

/**
 * @param {string} raw stdin contents
 * @returns {{blocked: true, message: string} | {blocked: false}}
 */
export function evaluate(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { blocked: false }; // fail open on unparseable input
  }

  const toolName =
    payload !== null && typeof payload === 'object' ? payload.tool_name : undefined;

  for (const candidate of extractPaths(payload)) {
    const hit = checkPath(candidate, toolName);
    if (hit) {
      return {
        blocked: true,
        message: `BLOCKED: ${candidate} must not be edited — ${hit.reason}.\n${hit.guidance}`,
      };
    }
  }

  return { blocked: false };
}

function main() {
  if (process.stdin.isTTY) {
    process.exit(0); // run by hand with no piped payload — nothing to check
  }

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    let verdict;
    try {
      verdict = evaluate(raw);
    } catch {
      process.exit(0); // fail open
    }
    if (verdict.blocked) {
      process.stderr.write(`${verdict.message}\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}

/**
 * Run main() only when this file is executed directly, never when a test imports it.
 *
 * Both sides are realpath'd: Node's ESM loader resolves symlinks in `import.meta.url`
 * but `process.argv[1]` keeps them, so a plain string compare silently fails whenever any
 * component of the project path is a symlink — and a hook that never runs is a hook that
 * protects nothing, with no sign that it is off.
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
