#!/usr/bin/env node
/**
 * PostToolUse hook — after a real `git commit`, remind that the knowledge log is not written yet.
 *
 * Wired in .claude/settings.json for Bash.
 *
 * The message reaches the model through `hookSpecificOutput.additionalContext` on stdout with
 * exit 0. That is the documented channel for PostToolUse; exit 2 does NOT block anything here
 * because the tool has already run, so there is nothing to block — this hook only ever nudges.
 *
 * ── Why a reminder and not an enforcement ───────────────────────────────────
 *
 * The comparable prose instruction in this repository is `fx-pre-push` step 10 ("did this change
 * decide something?"). Measured over the last 90 days on `dev`: 280 commits, 10 of which touched
 * `decisions.md`. Prose that depends on the model remembering gets followed about 4% of the time.
 * A hook fires every time, which is the whole reason this file exists.
 *
 * It still cannot make anyone write a good entry, and it goes silent once one exists.
 *
 * ── Honest limits, so nobody over-trusts it ─────────────────────────────────
 *
 * It only sees commits made through an agent's Bash tool in Claude Code. A commit typed in a
 * terminal, or made by Cursor, never reaches this hook. A real git `post-commit` hook would cover
 * those, but a git hook cannot ask a model to write prose — it could only leave a stub — and it
 * has to be installed on every machine by hand. This covers the case that actually produces the
 * knowledge worth logging: an agent session.
 *
 * FAILS SILENT. Any error at all exits 0 with no output. A reminder is worth nothing if it can
 * interrupt the work it is reminding about.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_PATH = 'docs/knowledge-log.md';

/**
 * True when the command actually creates a commit.
 *
 * Anchored to a command position so a `git commit` inside a quoted argument — `grep -rn
 * "git commit" docs/` — does not fire it. A guard that nags on a grep is a guard people switch
 * off, which is the same reasoning the protected-path hooks are built on.
 *
 * `--dry-run` is excluded because nothing was committed, so there is nothing to log.
 *
 * @param {string} command
 */
export function isRealCommit(command) {
  if (typeof command !== 'string' || command === '') return false;
  // Strip quoted spans first: their contents are data, not commands.
  const unquoted = command.replace(/"[^"]*"|'[^']*'/g, ' ');
  const atCommandPosition =
    /(?:^|[;&|(]|\b(?:then|do|else)\s)\s*(?:\w+=\S+\s+)*git\s+(?:-{1,2}\S+(?:\s+\S+)?\s+)*commit\b/;
  if (!atCommandPosition.test(unquoted)) return false;
  if (/\s--dry-run\b/.test(unquoted)) return false;
  return true;
}

/** Walk up from `start` to the directory containing a `.git` entry. */
function repoRootFrom(start) {
  let dir = start;
  for (let i = 0; i < 20; i += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Whether the log already carries an entry for this commit.
 *
 * The log trails the commit it describes by design: a commit's short SHA does not exist until the
 * commit does, so the entry is written afterwards and rides along with the next commit. That is
 * why the check is "is HEAD's SHA already in the file", and why this hook goes quiet as soon as
 * the entry is written rather than nagging until it is committed.
 *
 * @param {string} root
 * @returns {{alreadyLogged: boolean, sha: string, subject: string} | null}
 */
export function logState(root, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  let sha = '';
  let subject = '';
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%h%n%s'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.split('\n');
    sha = (lines[0] ?? '').trim();
    subject = (lines[1] ?? '').trim();
  } catch {
    return null;
  }
  if (!sha) return null;

  let contents = '';
  try {
    contents = readFile(path.join(root, LOG_PATH));
  } catch {
    contents = ''; // no log yet — that is itself a reason to remind
  }
  return { alreadyLogged: contents.includes(sha), sha, subject };
}

/**
 * @param {string} raw the PostToolUse payload
 * @returns {string | null} the reminder, or null for silence
 */
export function evaluate(raw, { cwdOverride } = {}) {
  const payload = JSON.parse(raw);
  if (payload?.tool_name !== 'Bash') return null;
  if (!isRealCommit(payload?.tool_input?.command)) return null;

  const root = repoRootFrom(cwdOverride ?? payload?.cwd ?? process.cwd());
  if (!root) return null;

  const state = logState(root);
  if (!state || state.alreadyLogged) return null;

  return (
    `Commit \`${state.sha}\` (${state.subject}) has no entry in ${LOG_PATH} yet. `
    + 'Add one now with the `fx-log-knowledge` skill: what you MEASURED (command and result), what '
    + 'you tried and REJECTED, what you LEFT OPEN, what existing claim you CORRECTED. '
    + 'If the commit taught nothing beyond its own message, write the heading and '
    + '"No finding beyond the commit message." on one line. Do not paraphrase the diff.'
  );
}

function main() {
  if (process.stdin.isTTY) process.exit(0);

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    let reminder = null;
    try {
      reminder = evaluate(raw);
    } catch {
      process.exit(0); // fail silent, always
    }
    if (reminder) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: reminder,
        },
      }));
    }
    process.exit(0);
  });
}

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
