import { defineConfig } from 'vitest/config';
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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/fx-buffer.ts'],
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
});
