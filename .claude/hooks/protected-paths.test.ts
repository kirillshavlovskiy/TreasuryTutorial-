/**
 * protected-paths.test.ts — the PreToolUse guard that blocks edits to platform-managed
 * and sync-managed paths.
 *
 * Every fixture here is a synthetic path. Nothing in this file is real data — the guard
 * only ever sees file names, and the rules it enforces are about location, not content.
 *
 * The most important case in this file is the last one: unparseable input must FAIL OPEN.
 * A hook that throws would block every edit in the repository, which is worse than having
 * no hook at all.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPath, extractPaths, evaluate } from './protected-paths.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'protected-paths.mjs');

/** Run the hook the way Claude Code runs it: a real process, payload on stdin. */
function runHook(payload: string) {
  return spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8' });
}

function payloadFor(filePath: string, toolName = 'Edit') {
  return JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath } });
}

describe('checkPath — platform-managed directories', () => {
  const blocked = [
    'helm/values.yaml',
    'helm/templates/deployment.yaml',
    'argocd/application.yaml',
    '.github/workflows/ci.yml',
    '.github/CODEOWNERS',
  ];

  for (const path of blocked) {
    it(`blocks ${path}`, () => {
      expect(checkPath(path)).not.toBeNull();
    });
  }

  it('names the directory in the reason so the person knows why', () => {
    expect(checkPath('helm/values.yaml')?.reason).toContain('helm/');
  });
});

describe('checkPath — platform-managed files', () => {
  it('blocks the Dockerfile', () => {
    expect(checkPath('Dockerfile')).not.toBeNull();
  });

  it('blocks a suffixed Dockerfile', () => {
    expect(checkPath('Dockerfile.production')).not.toBeNull();
  });

  it('blocks values.yaml at the repository root', () => {
    expect(checkPath('values.yaml')).not.toBeNull();
  });
});

describe('checkPath — matches on path segments, not on a prefix', () => {
  it('blocks a protected path inside a git worktree copy', () => {
    expect(checkPath('.claude/worktrees/some-branch/helm/values.yaml')).not.toBeNull();
  });

  it('blocks a protected path given as an absolute path', () => {
    expect(checkPath('/Users/someone/projects/repo/argocd/app.yaml')).not.toBeNull();
  });

  it('blocks a protected path written with Windows separators', () => {
    expect(checkPath('C:\\projects\\repo\\helm\\values.yaml')).not.toBeNull();
  });

  it('does not block a file whose name merely starts with a protected directory name', () => {
    expect(checkPath('lib/helmet-config.ts')).toBeNull();
  });

  it('does not block a directory whose name merely contains a protected name', () => {
    expect(checkPath('packages/my-helm-chart-generator/index.ts')).toBeNull();
  });
});

describe('checkPath — read-only knowledge layers', () => {
  it('blocks the department layer', () => {
    expect(checkPath('.claude/rules/dept/compliance.md')).not.toBeNull();
  });

  it('blocks the division layer', () => {
    expect(checkPath('.claude/rules/div/standards.md')).not.toBeNull();
  });

  it('blocks the layer directory itself', () => {
    expect(checkPath('.claude/rules/dept')).not.toBeNull();
  });

  it('points at the right sync command for the department layer', () => {
    expect(checkPath('.claude/rules/dept/a.md')?.guidance).toContain('/sync-dept');
  });

  it('points at the right sync command for the division layer', () => {
    expect(checkPath('.claude/rules/div/a.md')?.guidance).toContain('/sync-division');
  });

  it('ALLOWS the project layer — that is the layer this team edits', () => {
    expect(checkPath('.claude/rules/project/context.md')).toBeNull();
    expect(checkPath('.claude/rules/project/decisions.md')).toBeNull();
  });
});

describe('checkPath — ordinary files are allowed', () => {
  const allowed = [
    'lib/fx-buffer.ts',
    'lib/fx-buffer.test.ts',
    'app/api/treasury/fx-rates/route.ts',
    'components/SwapOverlay.tsx',
    'README.md',
    '.env.example',
    '.claude/skills/fx-review/SKILL.md',
    'package.json',
  ];

  for (const path of allowed) {
    it(`allows ${path}`, () => {
      expect(checkPath(path)).toBeNull();
    });
  }
});

describe('checkPath — malformed input is allowed through', () => {
  const nonPaths = [null, undefined, 42, {}, [], '', '   '];

  for (const value of nonPaths) {
    it(`returns null for ${JSON.stringify(value) ?? String(value)}`, () => {
      expect(checkPath(value)).toBeNull();
    });
  }
});

describe('extractPaths', () => {
  it('reads file_path, which Edit and Write use', () => {
    expect(extractPaths({ tool_input: { file_path: 'helm/values.yaml' } })).toEqual([
      'helm/values.yaml',
    ]);
  });

  it('reads notebook_path, which NotebookEdit uses', () => {
    expect(extractPaths({ tool_input: { notebook_path: 'analysis.ipynb' } })).toEqual([
      'analysis.ipynb',
    ]);
  });

  it('returns nothing when tool_input is absent', () => {
    expect(extractPaths({})).toEqual([]);
  });

  it('returns nothing for a non-object payload', () => {
    expect(extractPaths(null)).toEqual([]);
    expect(extractPaths('a string')).toEqual([]);
  });

  it('ignores blank and non-string values', () => {
    expect(extractPaths({ tool_input: { file_path: '', notebook_path: 7 } })).toEqual([]);
  });
});

describe('evaluate — the full stdin-to-verdict path', () => {
  it('blocks a protected path and explains why', () => {
    const verdict = evaluate(JSON.stringify({ tool_input: { file_path: 'helm/values.yaml' } }));
    expect(verdict.blocked).toBe(true);
    expect(verdict.blocked && verdict.message).toContain('BLOCKED');
    expect(verdict.blocked && verdict.message).toContain('helm/values.yaml');
  });

  it('allows an ordinary path', () => {
    const verdict = evaluate(JSON.stringify({ tool_input: { file_path: 'lib/fx-hedge.ts' } }));
    expect(verdict.blocked).toBe(false);
  });

  // If this test ever fails, the hook can block every edit in the repository.
  it('FAILS OPEN on unparseable input', () => {
    expect(evaluate('not json at all').blocked).toBe(false);
    expect(evaluate('').blocked).toBe(false);
    expect(evaluate('{"tool_input": {broken').blocked).toBe(false);
  });

  it('fails open on valid JSON with an unexpected shape', () => {
    expect(evaluate('[]').blocked).toBe(false);
    expect(evaluate('null').blocked).toBe(false);
    expect(evaluate('"just a string"').blocked).toBe(false);
  });
});

describe('checkPath — path traversal is resolved before matching', () => {
  // Without normalisation, `..` walks straight past the segment check and a read-only
  // knowledge file becomes silently overwritable.
  it('blocks a protected path reached through ..', () => {
    expect(checkPath('.claude/rules/project/../dept/department.md')).not.toBeNull();
    expect(checkPath('lib/../helm/values.yaml')).not.toBeNull();
    expect(checkPath('./app/../argocd/application.yaml')).not.toBeNull();
  });

  // The mirror error: a path that merely passes through a protected directory name
  // but resolves somewhere ordinary must not be blocked.
  it('allows an ordinary path that traverses out of a protected directory', () => {
    expect(checkPath('helm/../lib/foo.ts')).toBeNull();
    expect(checkPath('.github/../components/Chart.tsx')).toBeNull();
  });

  it('handles a trailing slash', () => {
    expect(checkPath('helm/')).not.toBeNull();
  });
});

describe('checkPath — matching is case-insensitive', () => {
  // macOS ships a case-insensitive filesystem by default, so every one of these opens
  // the real protected file. Exact-case matching leaves them all editable.
  const blocked = [
    'dockerfile',
    'DOCKERFILE',
    'values.YAML',
    'HELM/templates/deployment.yaml',
    'Helm/values.yaml',
    '.GitHub/workflows/ci.yml',
    'ArgoCD/application.yaml',
  ];

  for (const filePath of blocked) {
    it(`blocks ${filePath}`, () => {
      expect(checkPath(filePath)).not.toBeNull();
    });
  }

  it('blocks a differently-cased knowledge layer', () => {
    expect(checkPath('.claude/rules/DEPT/compliance.md')).not.toBeNull();
    expect(checkPath('.CLAUDE/rules/div/standards.md')).not.toBeNull();
  });
});

describe('checkPath — knowledge layers distinguish a sync from a hand edit', () => {
  // /sync-dept and /sync-division refresh these layers by WRITING the files
  // ("always overwrite", .claude/commands/sync-dept.md). Blocking every write would
  // make the layers impossible to update, and the refusal would name the very command
  // it just blocked. In-place edits are the hand-tweak this guard is for.
  it('allows a full overwrite, which is how the sync commands work', () => {
    expect(checkPath('.claude/rules/dept/department.md', 'Write')).toBeNull();
    expect(checkPath('.claude/rules/div/standards.md', 'Write')).toBeNull();
  });

  it('blocks an in-place edit', () => {
    expect(checkPath('.claude/rules/dept/department.md', 'Edit')).not.toBeNull();
    expect(checkPath('.claude/rules/div/standards.md', 'NotebookEdit')).not.toBeNull();
  });

  // The exemption is an ALLOWLIST of full-overwrite tools. Listing in-place editors instead
  // would hand the exemption to any name not on the list, so the layers would quietly stop
  // being protected the day the harness renames Edit or adds ApplyPatch/StrReplace.
  it('defaults to the stricter reading for an UNKNOWN TOOL NAME', () => {
    for (const unknown of ['SomeFutureEditTool', 'ApplyPatch', 'StrReplace', 'edit-v2', '']) {
      expect(checkPath('.claude/rules/dept/department.md', unknown)).not.toBeNull();
    }
  });

  it('defaults to the stricter reading for a non-string tool name', () => {
    expect(checkPath('.claude/rules/dept/department.md', undefined)).not.toBeNull();
    expect(checkPath('.claude/rules/dept/department.md', 42)).not.toBeNull();
    expect(checkPath('.claude/rules/dept/department.md', null)).not.toBeNull();
  });

  // Only the exact full-overwrite tool is exempt, case-insensitively.
  it('exempts only Write', () => {
    expect(checkPath('.claude/rules/dept/department.md', 'Write')).toBeNull();
    expect(checkPath('.claude/rules/dept/department.md', 'write')).toBeNull();
    expect(checkPath('.claude/rules/dept/department.md', 'WRITE')).toBeNull();
  });

  // Deployment paths have no legitimate write path at all, so the exemption must not
  // leak to them.
  it('never exempts a deployment path, whatever the tool', () => {
    expect(checkPath('helm/values.yaml', 'Write')).not.toBeNull();
    expect(checkPath('Dockerfile', 'Write')).not.toBeNull();
    expect(checkPath('.github/workflows/ci.yml', 'Write')).not.toBeNull();
  });
});

describe('the hook as a process — this is what Claude Code actually runs', () => {
  // Pure-function tests pass even when the script never executes: a mismatch in the
  // entry-point guard makes main() dead, and a dead guard protects nothing while
  // looking healthy. Only spawning the real process catches that.
  // The reason must be on STDERR. PreToolUse feeds stderr back to the model on exit 2;
  // stdout is transcript-only. Asserting on stdout would pass while the model receives an
  // unexplained block — and the text it loses is the "do not retry with Write" guidance.
  it('exits 2 and explains itself ON STDERR when a path is protected', () => {
    const result = runHook(payloadFor('helm/values.yaml'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('BLOCKED');
    expect(result.stderr).toContain('helm/values.yaml');
    expect(result.stdout.trim()).toBe('');
  });

  it('puts the do-not-retry-with-Write guidance where the model will see it', () => {
    const result = runHook(payloadFor('.claude/rules/dept/department.md', 'Edit'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Do NOT retry this with Write');
  });

  it('exits 0 silently for an ordinary path', () => {
    const result = runHook(payloadFor('lib/fx-buffer.ts'));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(result.stderr.trim()).toBe('');
  });

  it('exits 0 on unparseable input rather than blocking everything', () => {
    expect(runHook('not json at all').status).toBe(0);
  });

  it('exits 0 on empty stdin without hanging', () => {
    const result = runHook('');
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('exits 0 on a large payload without hanging', () => {
    const big = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: 'lib/fx-buffer.ts', content: 'x'.repeat(200_000) },
    });
    const result = runHook(big);
    expect(result.status).toBe(0);
  });

  it('honours the Write exemption end to end', () => {
    expect(runHook(payloadFor('.claude/rules/dept/department.md', 'Write')).status).toBe(0);
    expect(runHook(payloadFor('.claude/rules/dept/department.md', 'Edit')).status).toBe(2);
  });
});
