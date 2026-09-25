/**
 * commit-knowledge-reminder.test.ts — the PostToolUse nudge that fires after a real `git commit`.
 *
 * Every fixture is a synthetic command string; nothing here creates a commit.
 *
 * The two failure directions are not symmetric. A missed reminder loses one log entry. A reminder
 * that fires on `grep -rn "git commit" docs/` trains people to ignore it, and then it loses every
 * entry — so the false-positive cases carry as much weight here as the real ones.
 */

import { describe, it, expect } from 'vitest';
import { evaluate, isRealCommit, logState } from './commit-knowledge-reminder.mjs';

describe('isRealCommit', () => {
  it('fires on the ordinary shapes of a commit', () => {
    expect(isRealCommit('git commit -m "x"')).toBe(true);
    expect(isRealCommit('git commit')).toBe(true);
    expect(isRealCommit('git commit --amend --no-edit')).toBe(true);
    expect(isRealCommit('git commit -F - ')).toBe(true);
  });

  it('fires when the commit follows another command', () => {
    expect(isRealCommit('git add -A && git commit -m "x"')).toBe(true);
    expect(isRealCommit('git status; git commit -m "x"')).toBe(true);
  });

  it('fires past git global options and leading assignments', () => {
    expect(isRealCommit('git -c user.name=x commit -m "y"')).toBe(true);
    expect(isRealCommit('GIT_AUTHOR_NAME=x git commit -m "y"')).toBe(true);
  });

  it('does NOT fire on a mention inside a quoted argument', () => {
    // The case that would make the reminder background noise.
    expect(isRealCommit('grep -rn "git commit" docs/')).toBe(false);
    expect(isRealCommit("rg 'git commit -m' .claude/")).toBe(false);
    expect(isRealCommit('echo "run git commit when ready"')).toBe(false);
  });

  it('does NOT fire on a dry run, because nothing was committed', () => {
    expect(isRealCommit('git commit --dry-run')).toBe(false);
  });

  it('does NOT fire on other git subcommands or lookalikes', () => {
    expect(isRealCommit('git status')).toBe(false);
    expect(isRealCommit('git log --format=%s')).toBe(false);
    expect(isRealCommit('npm test')).toBe(false);
    expect(isRealCommit('git-commit-helper --run')).toBe(false);
  });

  it('is safe on junk input', () => {
    expect(isRealCommit('')).toBe(false);
    expect(isRealCommit(undefined as unknown as string)).toBe(false);
    expect(isRealCommit(42 as unknown as string)).toBe(false);
  });
});

describe('evaluate — payload routing', () => {
  const payload = (command: string, tool = 'Bash') =>
    JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: tool,
      cwd: process.cwd(),
      tool_input: { command },
    });

  it('stays silent for a tool that is not Bash', () => {
    expect(evaluate(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x' } })))
      .toBeNull();
  });

  it('stays silent for a command that is not a commit', () => {
    expect(evaluate(payload('npm test'))).toBeNull();
    expect(evaluate(payload('grep -rn "git commit" docs/'))).toBeNull();
  });

  it('throws on an unreadable payload so main() can fail silent', () => {
    // main() catches this and exits 0. Returning null here instead would make a malformed
    // payload indistinguishable from a deliberate decision to stay quiet.
    expect(() => evaluate('not json')).toThrow();
  });

  it('names the commit and the skill when an entry is missing', () => {
    // HEAD's SHA is not in the log on this branch, so the reminder is expected to fire.
    const out = evaluate(payload('git commit -m "x"'));
    expect(out).toContain('docs/knowledge-log.md');
    expect(out).toContain('fx-log-knowledge');
    expect(out).toContain('MEASURED');
  });

});

describe('logState — the "already written?" check', () => {
  // These drive the real `git log -1` in this repository but inject the file read, so the
  // already-logged branch is exercised deterministically instead of depending on what happens
  // to be in the log today.

  it('reports not-logged when the log does not mention HEAD', () => {
    const state = logState(process.cwd(), () => '# Knowledge log\n\nnothing here yet\n');
    expect(state).not.toBeNull();
    expect(state!.alreadyLogged).toBe(false);
    expect(state!.sha).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('reports logged once the file contains HEAD\'s short SHA', () => {
    // Two-pass: read the real SHA, then feed it back as if an entry had been written.
    const probe = logState(process.cwd(), () => '');
    expect(probe).not.toBeNull();
    const withEntry = logState(process.cwd(), () => `## 2026-09-14 \`${probe!.sha}\` subject\n`);
    expect(withEntry!.alreadyLogged).toBe(true);
  });

  it('treats a missing log file as not-logged, which is itself worth reminding about', () => {
    const state = logState(process.cwd(), () => {
      throw new Error('ENOENT');
    });
    expect(state!.alreadyLogged).toBe(false);
  });

});
