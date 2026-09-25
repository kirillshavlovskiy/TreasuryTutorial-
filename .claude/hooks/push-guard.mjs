#!/usr/bin/env node
/**
 * PreToolUse hook — refuse `git push` to a protected branch, allow it on any other branch.
 *
 * Wired in .claude/settings.json for Bash.
 *
 * Exit 2  = block. The reason MUST go to stderr — that is the channel PreToolUse feeds back on
 *           exit 2, and exit 2 stops the call BEFORE permission rules are evaluated.
 * stdout  = a PreToolUse decision object, used only to `allow` a push this guard has positively
 *           established is safe AND that is the only thing in the command.
 * Exit 0, no output = no opinion; the normal permission flow decides.
 *
 * ── This is an ALLOWLIST, and that is the whole design ───────────────────────
 *
 * The first version of this file enumerated the dangerous forms and allowed the rest. It had 35
 * passing tests and twelve bypasses, every one of which put a commit on `dev` while the hook
 * reported `allow`: `git push -4 origin x:dev` (a boolean flag listed as value-taking, so the
 * remote was eaten and the refspec misread), `git push origin @` and `origin heads/dev` (ref
 * synonyms it did not normalise), `/usr/bin/git push`, `env git push`, `sudo git push` (the
 * command word had to equal `git` exactly), `git --attr-source HEAD push` (an unknown global
 * option hid the subcommand), and more.
 *
 * Enumerating bad shapes is unwinnable against a shell. So this version inverts it: a push is
 * allowed ONLY when the command is a shape this guard fully understands and the destination
 * provably is not protected. Everything else that could possibly be a push is refused, and the
 * operator is told to run it by hand. A refusal costs one manual command; a miss costs unreviewed
 * code on `dev`.
 *
 * ── What actually protects `dev` ─────────────────────────────────────────────
 *
 * This hook, and nothing else. Measured 2026-09-08:
 *   gh api repos/.../branches/dev            → "protected": true
 *   gh api repos/.../branches/dev/protection → 404, no classic protection
 *   gh api repos/.../rules/branches/dev      → ["deletion", "repository_delete", ...]
 * The only rule on `dev` and `main` is *deletion*, from a ruleset named
 * "Do-not-Delete-dev-main-and-master-branch". There is no pull-request requirement and no
 * force-push block, so `.protected: true` is misleading — a direct `git push origin dev` is
 * accepted by the server.
 *
 * So do NOT write, anywhere, that a missed push would be caught by GitHub. An earlier version of
 * this header, the ADR, the block message and `fx-pre-push` all said so on the strength of that
 * boolean, and all four were wrong.
 *
 * It also does not run for a person at a terminal: this is a Claude Code `PreToolUse` hook plus a
 * Cursor adapter. There is no git `pre-push` hook installed and `core.hooksPath` is unset.
 *
 * ── Failure modes, stated precisely ─────────────────────────────────────────
 *
 * A command this file cannot parse, or a target it cannot resolve, is BLOCKED. An exception
 * anywhere in the analysis is BLOCKED. Only a payload that is not readable JSON exits 0 — that
 * is not evidence of a push, and blocking every Bash call in the session over it would be worse.
 *
 * `protected-paths.mjs`, the sibling hook, deliberately fails OPEN, because a throw there blocks
 * every edit in the repository. Here a throw blocks pushes, which is the behaviour this
 * repository had before this file existed. Do not harmonise the two failure modes.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Branches that take changes only through a pull request.
 * `CLAUDE.md` → Git Workflow: "Never commit directly to `main` or `dev`".
 */
export const PROTECTED_BRANCHES = ['dev', 'main', 'master'];

/** Shell operators that end one command and begin another. */
const SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&', '\n', '(', ')', '{', '}']);

/**
 * Split a command line into tokens.
 *
 * `quoted` records that some part of the token came from inside quotes, which is what keeps
 * `grep -rn "git push" docs/` from being read as a push. `expands` records that the shell would
 * substitute something in, which makes the token's value unknowable here.
 *
 * @param {string} command
 * @returns {{text: string, quoted: boolean, expands: boolean, separator: boolean}[]}
 */
export function tokenize(command) {
  const tokens = [];
  let text = '';
  let started = false;
  let quoted = false;
  let expands = false;
  let quote = null;

  const flush = () => {
    if (started) tokens.push({ text, quoted, expands, separator: false });
    text = '';
    started = false;
    quoted = false;
    expands = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (quote) {
      // Inside double quotes a backslash escapes `$`, a backtick, `"` and itself. Missing this
      // split a token at an escaped quote, so the rest of a perfectly ordinary
      // `node -e "...git push..."` became UNQUOTED and was refused as an unanalysable push.
      if (quote === '"' && char === '\\' && i + 1 < command.length
        && ['$', '`', '"', '\\'].includes(command[i + 1])) {
        text += command[i + 1];
        i += 1;
        started = true;
        quoted = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      } else {
        if (quote === '"' && (char === '$' || char === '`')) expands = true;
        text += char;
      }
      started = true;
      quoted = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      quoted = true;
      continue;
    }

    if (char === '$' || char === '`') {
      expands = true;
      text += char;
      started = true;
      continue;
    }

    if (char === '\\' && i + 1 < command.length) {
      text += command[i + 1];
      started = true;
      i += 1;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      if (char === '\n') tokens.push({ text: '\n', quoted: false, expands: false, separator: true });
      continue;
    }

    // A heredoc body is DATA, not commands. Without this, writing a runbook or a test file whose
    // text mentions `git push origin dev` was refused as an unanalysable push — the "guard that
    // blocks harmless work gets switched off" failure, and it fired on this guard's own tests.
    if (char === '<' && command[i + 1] === '<') {
      let j = i + 2;
      if (command[j] === '-') j += 1;
      while (j < command.length && /[ \t]/.test(command[j])) j += 1;
      let delimiter = '';
      let delimQuote = null;
      if (command[j] === '"' || command[j] === "'") {
        delimQuote = command[j];
        j += 1;
      }
      while (j < command.length && (delimQuote ? command[j] !== delimQuote : /[A-Za-z0-9_]/.test(command[j]))) {
        delimiter += command[j];
        j += 1;
      }
      if (delimQuote) j += 1;
      if (delimiter !== '') {
        flush();
        // Skip from the end of this line to the terminator line.
        const bodyStart = command.indexOf('\n', j);
        if (bodyStart === -1) {
          i = command.length;
          continue;
        }
        const lines = command.slice(bodyStart + 1).split('\n');
        let consumed = bodyStart + 1;
        let closed = false;
        for (const line of lines) {
          consumed += line.length + 1;
          if (line.trim() === delimiter) {
            closed = true;
            break;
          }
        }
        // An unterminated heredoc swallows the rest of the string, which is what the shell does.
        i = (closed ? consumed : command.length) - 1;
        tokens.push({ text: '\n', quoted: false, expands: false, separator: true });
        continue;
      }
    }

    const two = command.slice(i, i + 2);
    if (SEPARATORS.has(two)) {
      flush();
      tokens.push({ text: two, quoted: false, expands: false, separator: true });
      i += 1;
      continue;
    }
    if (SEPARATORS.has(char)) {
      flush();
      tokens.push({ text: char, quoted: false, expands: false, separator: true });
      continue;
    }

    text += char;
    started = true;
  }
  flush();
  return tokens;
}

/** `git`, `/usr/bin/git`, `git.exe` — the command word, path and extension stripped. */
export function isGitCommandWord(text) {
  const base = text.split('/').pop()?.split('\\').pop() ?? '';
  return base === 'git' || base === 'git.exe';
}

/**
 * Could this command line possibly run `git push`?
 *
 * Deliberately generous, and used only to decide between "block, I cannot analyse this" and "no
 * opinion". A quoted mention does not count, so a grep or an echo is not a push. Anything else
 * that pairs a git-ish command word with a `push` word does, however it is wrapped.
 *
 * @param {{text: string, quoted: boolean, separator: boolean}[]} tokens
 */
export function mightBePush(tokens) {
  const unquoted = tokens.filter((t) => !t.separator && !t.quoted);

  // An indirect executor runs its ARGUMENT as a command, so quoting stops meaning "data" —
  // `eval 'git push origin dev'` pushes. Where one of these is present, a quoted mention counts
  // too. This can over-block (`bash -c "echo git push"`), and that is the right way round: a
  // shell inside a shell is precisely what this guard cannot analyse.
  const indirect = unquoted.some((t, idx) => {
    const base = t.text.split('/').pop() ?? '';
    if (base === 'eval') return true;
    if (!['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(base)) return false;
    return unquoted.slice(idx + 1).some((a) => a.text === '-c');
  });
  // Outside an indirect executor, match the command word EXACTLY. A substring match here flags
  // `git-push-helper`, which is a different program, and a guard that refuses someone's tool is
  // a guard they remove.
  const exactGit = unquoted.findIndex((t) => isGitCommandWord(t.text));
  if (exactGit !== -1 && unquoted.slice(exactGit + 1).some((t) => t.text === 'push')) return true;

  if (!indirect) return false;

  // Inside `eval` / `sh -c` the argument is a script, so look at its text rather than its
  // tokens. Over-blocking here is deliberate: a shell inside a shell is unanalysable.
  return tokens
    .filter((t) => !t.separator)
    .some((t) => /(^|[^\w-])git\s+(?:-\S+\s+)*push(\s|$)/.test(t.text));
}

/** Command words that wrap another command without changing what it does. */
const WRAPPERS = new Set(['env', 'sudo', 'command', 'time', 'nohup', 'nice', 'stdbuf', 'xargs']);

/** Options to `git` itself that take a value in the next token. */
const GIT_GLOBAL_VALUE_OPTS = new Set([
  '-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix',
  '--config-env', '--attr-source',
]);

/** `git push` options that never take a value. */
const PUSH_BOOLEAN = new Set([
  '-u', '--set-upstream', '-f', '--force', '--all', '--mirror', '--tags', '--follow-tags',
  '--no-follow-tags', '-d', '--delete', '-n', '--dry-run', '--porcelain', '-q', '--quiet',
  '-v', '--verbose', '--progress', '--no-progress', '--atomic', '--no-atomic', '--thin',
  '--no-thin', '--prune', '--no-verify', '--verify', '-4', '--ipv4', '-6', '--ipv6',
  '--force-with-lease', '--no-force-with-lease', '--force-if-includes',
  '--no-force-if-includes', '--signed', '--no-signed', '--recurse-submodules',
  '--no-recurse-submodules', '--repo',
]);

/** `git push` options that take a value in the NEXT token. */
const PUSH_VALUE_NEXT = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);

/**
 * Parse a command line that is nothing but one `git push`.
 *
 * Returns `null` when the command is not exactly that shape — several commands, a wrapper, a
 * substitution, an unknown option. The caller blocks in that case rather than guessing.
 *
 * @param {string} command
 * @returns {{force: boolean, deleteMode: boolean, everything: boolean, refspecs: string[],
 *   remote: string | null, chdir: boolean} | null}
 */
export function parseLonePush(command) {
  const tokens = tokenize(command);
  if (tokens.some((t) => t.separator)) return null;      // more than one command, or a subshell
  if (tokens.some((t) => t.expands)) return null;        // a value only the shell knows

  let i = 0;
  // Leading `VAR=value` assignments are allowed; a wrapper command is not, because it changes
  // where the arguments start and `xargs`/`eval` change what runs entirely.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].text)) i += 1;
  if (i >= tokens.length) return null;
  if (WRAPPERS.has(tokens[i].text) || tokens[i].text === 'eval') return null;
  if (!isGitCommandWord(tokens[i].text)) return null;
  i += 1;

  // git's own options, up to the subcommand.
  let chdir = false;
  while (i < tokens.length && tokens[i].text.startsWith('-')) {
    const opt = tokens[i].text;
    const bare = opt.includes('=') ? opt.slice(0, opt.indexOf('=')) : opt;
    if (bare === '-C' || bare === '--git-dir' || bare === '--work-tree') chdir = true;
    if (GIT_GLOBAL_VALUE_OPTS.has(bare)) {
      i += opt.includes('=') ? 1 : 2;
      continue;
    }
    // An option this guard does not know might or might not eat the next token. Either reading
    // could hide the subcommand, so refuse the whole command.
    return null;
  }
  if (i >= tokens.length || tokens[i].text !== 'push') return null;
  i += 1;

  const result = {
    force: false, deleteMode: false, everything: false, refspecs: [], remote: null, chdir,
  };
  let endOfOptions = false;

  for (; i < tokens.length; i += 1) {
    const arg = tokens[i].text;
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith('-') && arg !== '-') {
      const bare = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      if (bare === '-f' || bare === '--force' || bare === '--force-with-lease'
        || bare === '--force-if-includes') result.force = true;
      if (bare === '-d' || bare === '--delete') result.deleteMode = true;
      if (bare === '--all' || bare === '--mirror') result.everything = true;
      if (PUSH_VALUE_NEXT.has(bare) && !arg.includes('=')) {
        i += 1;
        continue;
      }
      if (PUSH_BOOLEAN.has(bare)) continue;
      // Clustered short flags, e.g. -uf.
      if (/^-[A-Za-z0-9]+$/.test(arg)) {
        let known = true;
        for (const letter of arg.slice(1)) {
          if (letter === 'f') result.force = true;
          else if (letter === 'd') result.deleteMode = true;
          else if (!'unqv46'.includes(letter)) known = false;
        }
        if (known) continue;
      }
      return null; // an option this guard does not recognise
    }
    if (result.remote === null) result.remote = arg;
    else result.refspecs.push(arg);
  }
  return result;
}

/**
 * Every branch name a refspec destination could mean.
 *
 * Git accepts several spellings of the same ref, and the first version of this guard compared
 * only the literal string: `git push origin @` and `git push origin heads/dev` both slipped
 * through. Returning candidates and blocking if ANY of them is protected is fail-safe — a
 * spelling this function over-expands can only cause an over-block.
 *
 * @param {string} spec one refspec destination
 * @param {string | null} currentBranch
 * @returns {string[] | null} null when the destination cannot be determined
 */
export function destinationCandidates(spec, currentBranch) {
  let dst = spec.replace(/^\+/, '');
  if (dst === '') return null;
  if (dst === 'HEAD' || dst === '@') {
    return currentBranch ? [currentBranch] : null;
  }
  // A revision expression is not a branch this guard can reason about.
  if (/[~^:]/.test(dst)) return null;
  const candidates = new Set([dst]);
  candidates.add(dst.replace(/^refs\/heads\//, ''));
  candidates.add(dst.replace(/^heads\//, ''));
  return [...candidates];
}

/**
 * The most specific reason the command could not be reduced to one analysable push.
 *
 * A guard that refuses without saying which part it choked on sends the operator guessing.
 *
 * @param {{text: string, quoted: boolean, expands: boolean, separator: boolean}[]} tokens
 */
function whyUnanalysable(tokens) {
  if (tokens.some((t) => t.expands)) {
    return 'it contains a shell variable or command substitution, whose value is only known when '
      + 'the shell runs it';
  }
  if (tokens.some((t) => t.separator)) {
    return 'it runs more than one command, and a decision here applies to the whole line';
  }
  const words = tokens.filter((t) => !t.separator).map((t) => t.text);
  const wrapper = words.find((w) => WRAPPERS.has(w.split('/').pop() ?? '') || w === 'eval');
  if (wrapper) return `it runs through \`${wrapper}\`, which changes what actually executes`;
  const flag = words.find((w) => w.startsWith('-'));
  if (flag) return `it carries an option this guard does not recognise (\`${flag}\`)`;
  return 'its shape is not one this guard recognises';
}

const BLOCK_SUFFIX =
  'Those branches take changes only through a pull request — see CLAUDE.md → Git Workflow. '
  + 'Push your feature branch instead and open a PR against `dev`.';

/**
 * The verdict for one Bash command.
 *
 * @param {string} command
 * @param {{currentBranch: () => string | null, pushDefault: () => string | null}} git
 * @returns {{decision: 'ignore' | 'allow' | 'block', message?: string}}
 */
export function checkPush(command, git) {
  const tokens = tokenize(command);
  if (!mightBePush(tokens)) return { decision: 'ignore' };

  const parsed = parseLonePush(command);
  if (!parsed) {
    return {
      decision: 'block',
      message:
        `This looks like a \`git push\` in a shape this guard cannot analyse — ${whyUnanalysable(tokens)}. `
        + 'It refuses rather than guess, because the branch a push reaches is not always written '
        + 'in the command. Run just the push on its own, for example `git push origin my-branch`, '
        + 'or run it yourself.',
    };
  }

  if (parsed.everything) {
    return {
      decision: 'block',
      message:
        `Refusing: \`--all\`/\`--mirror\` pushes every local branch, which includes `
        + `\`${PROTECTED_BRANCHES.join('`, `')}\`. ${BLOCK_SUFFIX}`,
    };
  }

  const targets = [];
  if (parsed.refspecs.length === 0) {
    // No destination in the command. It comes from push.default and the upstream, and only two
    // of those settings make it equal the current branch name.
    if (parsed.chdir) {
      return {
        decision: 'block',
        message:
          'This push names no branch and runs in another directory (`-C` / `--git-dir`), so the '
          + 'branch it would update cannot be determined from here. Name the branch explicitly, '
          + 'or run it yourself.',
      };
    }
    const mode = git.pushDefault();
    if (mode !== null && mode !== 'simple' && mode !== 'current') {
      return {
        decision: 'block',
        message:
          `\`push.default\` is \`${mode}\`, so a push with no refspec does not necessarily go to a `
          + 'branch of the same name — with `upstream` or `matching` it can land on `dev`. Name '
          + 'the destination explicitly.',
      };
    }
    const branch = git.currentBranch();
    if (!branch) {
      return {
        decision: 'block',
        message:
          'The current branch could not be determined (a detached HEAD, or git failed), so this '
          + 'guard cannot tell whether the push would reach a protected branch.',
      };
    }
    targets.push(branch);
  }

  for (const spec of parsed.refspecs) {
    const colon = spec.indexOf(':');
    const dst = colon === -1 ? spec : spec.slice(colon + 1);
    if (colon !== -1 && dst === '') {
      // `src:` — not a branch push this guard can read.
      return {
        decision: 'block',
        message: `Refusing: the refspec \`${spec}\` has no destination this guard can read.`,
      };
    }
    const candidates = destinationCandidates(dst, git.currentBranch());
    if (candidates === null) {
      return {
        decision: 'block',
        message:
          `Refusing: \`${spec}\` names a destination this guard cannot resolve to a branch. `
          + 'Write the branch name plainly, or run it yourself.',
      };
    }
    targets.push(...candidates);
  }

  const hits = [...new Set(
    targets.filter((t) => PROTECTED_BRANCHES.includes(t.toLowerCase())),
  )];
  if (hits.length > 0) {
    return {
      decision: 'block',
      message:
        `Refusing to ${parsed.force ? 'force-push' : 'push'} to \`${hits.join('`, `')}\`. `
        + BLOCK_SUFFIX,
    };
  }

  return {
    decision: 'allow',
    message: `push to \`${[...new Set(targets)].join('`, `')}\` — not a protected branch`,
  };
}

/** @param {string} cwd */
function gitAccessors(cwd) {
  const run = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: cwd || process.cwd(),
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  return {
    currentBranch: () => {
      const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
      return branch === '' || branch === 'HEAD' ? null : branch;
    },
    // null means unset, which is git's built-in `simple`.
    pushDefault: () => run(['config', '--get', 'push.default']) || null,
  };
}

/**
 * @param {string} raw the PreToolUse payload
 * @returns {{decision: 'ignore' | 'allow' | 'block', message?: string}}
 */
export function evaluate(raw) {
  const payload = JSON.parse(raw);
  if (payload?.tool_name !== 'Bash') return { decision: 'ignore' };
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || command.trim() === '') return { decision: 'ignore' };
  return checkPush(command, gitAccessors(payload?.cwd));
}

function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
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
    // Two failure modes, deliberately different. An unreadable payload is not evidence of a
    // push, so it exits 0 and leaves the decision to the normal permission flow. A payload that
    // parses but then throws during analysis IS potentially a push, so it blocks.
    let payloadOk = false;
    try {
      JSON.parse(raw);
      payloadOk = true;
    } catch {
      process.exit(0);
    }

    let verdict;
    try {
      verdict = evaluate(raw);
    } catch (err) {
      if (payloadOk) {
        block(
          'This guard failed while analysing the command, so it cannot say whether the push would '
          + `reach a protected branch: ${err?.message || err}. Run the push yourself if you are `
          + 'sure.',
        );
      }
      process.exit(0);
    }

    if (verdict.decision === 'block') block(verdict.message);
    if (verdict.decision === 'allow') {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: verdict.message,
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
