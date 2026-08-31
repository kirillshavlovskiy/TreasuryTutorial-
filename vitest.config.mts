import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // tsconfig.json sets jsx: "preserve" for Next.js' own compiler — vitest's
  // own transform needs its own jsx mode or it fails to parse .tsx files
  // pulled in by a test (e.g. importing a pure helper co-located in one).
  oxc: { jsx: 'automatic' },
  test: {
    globals: true,
    environment: 'node',
    // The CFaR suite runs full Monte Carlo simulations — several thousand
    // paths over three nested ledgers, often a handful of times in one case.
    // The 5s default makes those flake on a loaded machine, and which case
    // trips varies run to run.
    testTimeout: 30_000,
    // Default include (**/*.test.ts) would otherwise also pick up stale
    // copies of test files left behind in ad-hoc git worktrees under
    // .claude/worktrees/ — those are separate checkouts, not this tree.
    // Scoped to worktrees only, not all of .claude/: the agent tooling in
    // .claude/hooks/ and .claude/skills/*/scripts/ ships its own tests and
    // those must run. Excluding all of .claude/ would silently skip them.
    // Extend, don't replace, the defaults — they also guard against
    // **/dist/**, .git/.cache/.output/.temp dirs, and tool config globs.
    exclude: [
      ...configDefaults.exclude,
      '**/.claude/worktrees/**',
      // Offline zip extracts dumped at repo root — not this tree's tests.
      '**/handover-*/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/fx-buffer.ts', 'lib/treasury/**/*.ts'],
      exclude: ['lib/treasury/**/*.test.ts'],
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
});
