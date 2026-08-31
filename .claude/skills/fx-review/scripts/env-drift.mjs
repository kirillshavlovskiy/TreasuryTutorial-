#!/usr/bin/env node
/**
 * Environment variable drift check.
 *
 * CLAUDE.md requires that three descriptions of this application's configuration agree:
 *   1. the code that reads process.env.*
 *   2. .env.example
 *   3. the Environment Variables table in README.md
 *
 * This script reports where they do not.
 *
 * Usage:
 *   node .claude/skills/fx-review/scripts/env-drift.mjs
 *   node .claude/skills/fx-review/scripts/env-drift.mjs --strict   # exit 1 when drift is found
 *
 * Default exit code is 0 even when drift exists, so that pre-existing drift does not fail an
 * unrelated change. fx-pre-push reads the report and decides.
 *
 * The grep is necessary but not sufficient: it cannot see a variable a library reads on its own
 * from process.env (NextAuth's AUTH_SECRET, the AWS SDK credential chain). Always read the
 * existing .env.example entries before concluding the list is complete.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Set by the platform, never by a person editing .env.local.
 *
 * Keep this list narrow. Anything a person could legitimately set locally belongs in
 * .env.example instead — including AWS_REGION and AWS_EC2_METADATA_DISABLED, which look
 * infrastructural but are real, overridable configuration in this application.
 */
export const RUNTIME_PROVIDED = new Set(['NODE_ENV', 'VERCEL_ENV', 'NODE_PATH']);

/**
 * Paths searched for process.env references. Matches the CLAUDE.md audit recipe exactly.
 *
 * `scripts/` is deliberately NOT here. It holds build and operational tooling whose variables
 * (`APPDATA`, `NEXT_FORCE_LOCAL_DIST`) are not application configuration and do not belong in
 * .env.example or the README. Adding it produces noise that trains people to ignore the report.
 */
export const SEARCH_PATHS = ['app', 'lib', 'components', 'auth.ts', 'next.config.ts'];

/**
 * Test files are excluded: a test may set a throwaway env toggle that has no business in
 * .env.example or the README, and reporting it as drift would block a push over a variable
 * nobody should ever configure. CLAUDE.md's audit recipe excludes them for the same reason.
 */
export const EXCLUDE_PATHSPECS = [':(exclude)**/*.test.ts', ':(exclude)**/*.test.tsx'];

/**
 * Variable names referenced as process.env.NAME in a blob of source text.
 *
 * @param {string} text
 * @returns {string[]} sorted, unique
 */
export function collectCodeVars(text) {
  const found = new Set();
  const pattern = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Variable names reached indirectly, which the dotted regex above cannot see.
 *
 * This codebase has an established `requireEnv('NAME')` idiom (`lib/treasury/okta-client.ts`,
 * `lib/treasury/mcp-client.ts`) and also indexes `process.env['NAME']`. Today every such name
 * also appears dotted somewhere, so the dotted scan happens to catch them — but the next
 * `requireEnv('NEW_NAME')` added without a dotted reference would be drift the script certified
 * as IN SYNC. Scan for both forms.
 *
 * @param {string} text
 * @returns {string[]} sorted, unique
 */
export function collectDynamicEnvVars(text) {
  const found = new Set();
  const patterns = [
    /requireEnv\(\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/g,
    /process\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Variable names ACTIVELY declared in a .env.example file — an uncommented `NAME=` line.
 * These are the variables a reader is expected to fill in.
 *
 * @param {string} text
 * @returns {string[]} sorted, unique
 */
export function collectExampleVars(text) {
  const found = new Set();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Variable names present as a COMMENTED assignment — `# NAME=` or `#NAME=`.
 *
 * This is a deliberate idiom in this repository, not an oversight: a commented entry with an
 * explanation above it documents an OPTIONAL variable. The application runs without it, and a
 * reader who copies the file gets a working setup. Counting these as undocumented makes the
 * drift check cry wolf, and a tool that cries wolf gets ignored.
 *
 * Prose that merely mentions a name does not count — only a commented assignment.
 *
 * @param {string} text
 * @returns {string[]} sorted, unique
 */
export function collectCommentedExampleVars(text) {
  const found = new Set();
  for (const line of text.split('\n')) {
    const match = /^#\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Variable names listed in the README Environment Variables table. Rows look like:
 *   | `AUTH_URL` | description | Required | example |
 *
 * @param {string} text
 * @returns {string[]} sorted, unique
 */
export function collectReadmeVars(text) {
  const found = new Set();
  for (const line of text.split('\n')) {
    const match = /^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/.exec(line);
    if (match) found.add(match[1]);
  }
  return [...found].sort();
}

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
 * Compare the three sources.
 *
 * `example` is the ACTIVE declarations in .env.example; `exampleOptional` is the commented
 * ones. Both count as documented — see collectCommentedExampleVars for why.
 *
 * @param {{code: string[], example: string[], readme: string[], exampleOptional?: string[]}} sources
 */
export function analyse({ code, example, readme, exampleOptional = [] }) {
  const appCode = code.filter((name) => !RUNTIME_PROVIDED.has(name));
  const runtimeInCode = code.filter((name) => RUNTIME_PROVIDED.has(name));
  const documented = [...new Set([...example, ...exampleOptional])].sort();

  // A runtime-provided variable belongs in the README, in its own "set by the runtime"
  // section, and must NOT be in .env.example — nobody should be invited to set it by hand.
  // So its presence in one and absence from the other is correct, not drift.
  const appReadme = readme.filter((name) => !RUNTIME_PROVIDED.has(name));

  return {
    runtimeInCode,
    runtimeInReadme: readme.filter((name) => RUNTIME_PROVIDED.has(name)),
    optionalInExample: exampleOptional,
    undocumentedInExample: missingFrom(appCode, documented),
    undocumentedInReadme: missingFrom(appCode, readme),
    exampleNotInCode: missingFrom(documented, code),
    readmeNotInExample: missingFrom(appReadme, documented),
    exampleNotInReadme: missingFrom(documented, readme),
    get hasDrift() {
      return (
        this.undocumentedInExample.length > 0 ||
        this.undocumentedInReadme.length > 0 ||
        this.readmeNotInExample.length > 0 ||
        this.exampleNotInReadme.length > 0
      );
    },
  };
}

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
    return '';
  }
}

function section(title, items, note) {
  if (items.length === 0) return `  ${title}: none\n`;
  const lines = items.map((item) => `      ${item}`).join('\n');
  const suffix = note ? `\n      (${note})` : '';
  return `  ${title}: ${items.length}\n${lines}${suffix}\n`;
}

function main() {
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

  let grepOutput = '';
  let scanFailed = false;
  try {
    grepOutput = execFileSync(
      'git',
      [
        'grep',
        // --untracked: a brand-new file is exactly where drift is introduced, and
        // fx-pre-push runs before the commit. Without this the gate reports IN SYNC on
        // the very change that added the variable.
        '--untracked',
        '-ohE',
        // Dotted access, plus the indirect idioms collectDynamicEnvVars understands.
        'process\\.env[.\\[][A-Za-z_\'"`][A-Za-z0-9_]*|requireEnv\\(\\s*[\'"`][A-Za-z_][A-Za-z0-9_]*',
        '--',
        ...SEARCH_PATHS,
        ...EXCLUDE_PATHSPECS,
      ],
      { cwd: root, encoding: 'utf8' },
    );
  } catch (error) {
    // git grep exits 1 when nothing matched — that is a real "no results", not a failure.
    // Any other status (git missing, not a repository, bad pathspec) means the scan never
    // ran, and reporting "IN SYNC" off an empty result would be a lie.
    if (error && error.status === 1) {
      grepOutput = '';
    } else {
      scanFailed = true;
    }
  }

  const codeVars = [
    ...new Set([...collectCodeVars(grepOutput), ...collectDynamicEnvVars(grepOutput)]),
  ].sort();

  // An empty code side cannot be right: this application reads many variables. Treat it as a
  // failed scan rather than as "nothing to report", or a broken scan silently passes the gate.
  if (scanFailed || codeVars.length === 0) {
    process.stdout.write(
      '\nENVIRONMENT VARIABLE DRIFT\n\n' +
        '  RESULT: SCAN FAILED — no process.env references were found.\n\n' +
        '  This is not the same as "no drift". Expected causes: git is unavailable, this is not\n' +
        '  a git repository, or a pathspec no longer matches. Fix the scan before trusting a\n' +
        `  verdict. Searched from: ${root}\n`,
    );
    process.exit(1);
  }

  const exampleText = readIfPresent(path.join(root, '.env.example'));

  const result = analyse({
    code: codeVars,
    example: collectExampleVars(exampleText),
    exampleOptional: collectCommentedExampleVars(exampleText),
    readme: collectReadmeVars(readIfPresent(path.join(root, 'README.md'))),
  });

  let report = '\nENVIRONMENT VARIABLE DRIFT\n\n';
  report += section('In code but missing from .env.example', result.undocumentedInExample);
  report += section('In code but missing from the README table', result.undocumentedInReadme);
  report += section('In README but missing from .env.example', result.readmeNotInExample);
  report += section('In .env.example but missing from README', result.exampleNotInReadme);
  report += section(
    'In .env.example but not referenced in code',
    result.exampleNotInCode,
    'may be read by a library rather than by this codebase — verify before removing',
  );
  report += section(
    'Commented out in .env.example',
    result.optionalInExample,
    'counts as documented. Commented does NOT mean optional — AUTH_URL is commented here and\n' +
      '       still required in production. Read the Required column in the README, not the comment',
  );
  report += section(
    'Runtime-provided, seen in code',
    result.runtimeInCode,
    'set by the platform; document in a separate subsection, do not ask people to set them',
  );

  report += result.hasDrift
    ? '\nRESULT: DRIFT FOUND\n'
    : '\nRESULT: IN SYNC\n';

  process.stdout.write(report);

  if (result.hasDrift && process.argv.includes('--strict')) {
    process.exit(1);
  }
  process.exit(0);
}

/**
 * Run main() only when this file is executed directly, never when a test imports it.
 *
 * Both sides are realpath'd: Node's ESM loader resolves symlinks in `import.meta.url` but
 * `process.argv[1]` keeps them, so a plain string compare silently fails whenever any component
 * of the project path is a symlink. The script would then print nothing and exit 0 — which
 * `fx-pre-push` step 6 would read as success, reopening the exact fail-silent path the
 * SCAN FAILED guard above exists to close.
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
