/**
 * env-drift.test.ts — the environment variable drift check.
 *
 * Every fixture here uses invented variable names (FAKE_*, SAMPLE_*). None of them exist
 * in this application. That is deliberate: fixtures must never carry real configuration,
 * and pinning the tests to the real variable list would make them fail every time someone
 * legitimately adds a variable.
 */

import { describe, it, expect } from 'vitest';
import {
  SEARCH_PATHS,
  EXCLUDE_PATHSPECS,
  collectCodeVars,
  collectDynamicEnvVars,
  collectExampleVars,
  collectCommentedExampleVars,
  collectReadmeVars,
  missingFrom,
  analyse,
  RUNTIME_PROVIDED,
} from './env-drift.mjs';

describe('collectCodeVars', () => {
  it('finds a process.env reference', () => {
    expect(collectCodeVars('const a = process.env.FAKE_TOKEN;')).toEqual(['FAKE_TOKEN']);
  });

  it('finds several references across lines', () => {
    const source = `
      const a = process.env.FAKE_ONE;
      const b = process.env.FAKE_TWO ?? 'default';
      if (process.env.FAKE_THREE === 'yes') {}
    `;
    expect(collectCodeVars(source)).toEqual(['FAKE_ONE', 'FAKE_THREE', 'FAKE_TWO']);
  });

  it('de-duplicates repeated references', () => {
    const source = 'process.env.FAKE_ONE; process.env.FAKE_ONE; process.env.FAKE_ONE;';
    expect(collectCodeVars(source)).toEqual(['FAKE_ONE']);
  });

  it('returns results sorted so the report is stable', () => {
    const source = 'process.env.ZED; process.env.ALPHA; process.env.MIKE;';
    expect(collectCodeVars(source)).toEqual(['ALPHA', 'MIKE', 'ZED']);
  });

  it('handles lowercase and mixed-case names, which this repository has', () => {
    expect(collectCodeVars('process.env.ssigma_FAKE_URL')).toEqual(['ssigma_FAKE_URL']);
  });

  it('finds nothing in text with no references', () => {
    expect(collectCodeVars('const total = amount + fee;')).toEqual([]);
    expect(collectCodeVars('')).toEqual([]);
  });
});

describe('collectExampleVars', () => {
  it('reads assignments', () => {
    const example = 'FAKE_ONE=\nFAKE_TWO=some-value\n';
    expect(collectExampleVars(example)).toEqual(['FAKE_ONE', 'FAKE_TWO']);
  });

  it('ignores comments and blank lines', () => {
    const example = `
# FAKE_COMMENTED=not-real
# A note about configuration

FAKE_REAL=
    `;
    expect(collectExampleVars(example)).toEqual(['FAKE_REAL']);
  });

  it('does not report a commented-out variable as an ACTIVE declaration', () => {
    expect(collectExampleVars('#FAKE_ONE=value')).toEqual([]);
  });

  it('ignores an indented line, which is not a valid assignment', () => {
    expect(collectExampleVars('   FAKE_ONE=value')).toEqual([]);
  });
});

describe('collectCommentedExampleVars', () => {
  // A commented assignment is how this repository documents an OPTIONAL variable. The
  // application runs without it, so the reader who copies the file still gets a working
  // setup. Treating these as undocumented made the check report 11 false positives.
  it('reads a commented assignment', () => {
    expect(collectCommentedExampleVars('# FAKE_ONE=value')).toEqual(['FAKE_ONE']);
  });

  it('reads a commented assignment with no space after the hash', () => {
    expect(collectCommentedExampleVars('#FAKE_ONE=value')).toEqual(['FAKE_ONE']);
  });

  it('reads a commented assignment with an empty value', () => {
    expect(collectCommentedExampleVars('# FAKE_ONE=')).toEqual(['FAKE_ONE']);
  });

  it('ignores prose that merely mentions a name', () => {
    expect(collectCommentedExampleVars('# FAKE_ONE may be injected by the platform')).toEqual([]);
    expect(collectCommentedExampleVars('# Set this before running')).toEqual([]);
  });

  it('ignores an active declaration', () => {
    expect(collectCommentedExampleVars('FAKE_ONE=value')).toEqual([]);
  });
});

describe('collectReadmeVars', () => {
  it('reads variable names out of the markdown table', () => {
    const readme = [
      '| Variable | Description | Required | Example |',
      '|----------|-------------|----------|---------|',
      '| `FAKE_ONE` | does a thing | Yes | abc |',
      '| `FAKE_TWO` | does another | No | def |',
    ].join('\n');
    expect(collectReadmeVars(readme)).toEqual(['FAKE_ONE', 'FAKE_TWO']);
  });

  it('ignores the header and separator rows', () => {
    const readme = '| Variable | Description |\n|---|---|\n| `FAKE_ONE` | x |';
    expect(collectReadmeVars(readme)).toEqual(['FAKE_ONE']);
  });

  it('ignores prose that mentions a variable outside the table', () => {
    expect(collectReadmeVars('Set `FAKE_ONE` before running the server.')).toEqual([]);
  });
});

describe('missingFrom', () => {
  it('returns items present in the first list only', () => {
    expect(missingFrom(['A', 'B', 'C'], ['B'])).toEqual(['A', 'C']);
  });

  it('returns nothing when everything is covered', () => {
    expect(missingFrom(['A'], ['A', 'B'])).toEqual([]);
  });

  it('handles empty inputs', () => {
    expect(missingFrom([], ['A'])).toEqual([]);
    expect(missingFrom(['A'], [])).toEqual(['A']);
  });
});

describe('analyse', () => {
  it('reports no drift when all three sources agree', () => {
    const result = analyse({
      code: ['FAKE_ONE', 'FAKE_TWO'],
      example: ['FAKE_ONE', 'FAKE_TWO'],
      readme: ['FAKE_ONE', 'FAKE_TWO'],
    });
    expect(result.hasDrift).toBe(false);
    expect(result.undocumentedInExample).toEqual([]);
    expect(result.undocumentedInReadme).toEqual([]);
  });

  it('catches a variable used in code but documented nowhere', () => {
    const result = analyse({
      code: ['FAKE_ONE', 'FAKE_UNDOCUMENTED'],
      example: ['FAKE_ONE'],
      readme: ['FAKE_ONE'],
    });
    expect(result.undocumentedInExample).toEqual(['FAKE_UNDOCUMENTED']);
    expect(result.undocumentedInReadme).toEqual(['FAKE_UNDOCUMENTED']);
    expect(result.hasDrift).toBe(true);
  });

  // This is the real shape of the drift found in this repository: the README documents a
  // variable that .env.example never mentions, so copying the example yields a broken setup.
  it('catches a variable in the README but missing from .env.example', () => {
    const result = analyse({
      code: ['FAKE_ONE'],
      example: [],
      readme: ['FAKE_ONE'],
    });
    expect(result.readmeNotInExample).toEqual(['FAKE_ONE']);
    expect(result.hasDrift).toBe(true);
  });

  it('catches a variable in .env.example but missing from the README', () => {
    const result = analyse({
      code: ['FAKE_ONE'],
      example: ['FAKE_ONE'],
      readme: [],
    });
    expect(result.exampleNotInReadme).toEqual(['FAKE_ONE']);
    expect(result.hasDrift).toBe(true);
  });

  it('reports a documented variable that code never references, without calling it drift', () => {
    // A library may read it directly from process.env — NextAuth and the AWS SDK both do.
    const result = analyse({
      code: [],
      example: ['FAKE_LIBRARY_READS_THIS'],
      readme: ['FAKE_LIBRARY_READS_THIS'],
    });
    expect(result.exampleNotInCode).toEqual(['FAKE_LIBRARY_READS_THIS']);
    expect(result.hasDrift).toBe(false);
  });

  it('counts a commented (optional) entry as documented', () => {
    const result = analyse({
      code: ['FAKE_OPTIONAL'],
      example: [],
      exampleOptional: ['FAKE_OPTIONAL'],
      readme: ['FAKE_OPTIONAL'],
    });
    expect(result.undocumentedInExample).toEqual([]);
    expect(result.optionalInExample).toEqual(['FAKE_OPTIONAL']);
    expect(result.hasDrift).toBe(false);
  });

  it('still flags a variable that is in neither the active nor the commented entries', () => {
    const result = analyse({
      code: ['FAKE_OPTIONAL', 'FAKE_TRULY_MISSING'],
      example: [],
      exampleOptional: ['FAKE_OPTIONAL'],
      readme: ['FAKE_OPTIONAL', 'FAKE_TRULY_MISSING'],
    });
    expect(result.undocumentedInExample).toEqual(['FAKE_TRULY_MISSING']);
    expect(result.hasDrift).toBe(true);
  });

  it('separates runtime-provided variables instead of demanding they be documented', () => {
    const result = analyse({
      code: ['NODE_ENV', 'VERCEL_ENV', 'FAKE_ONE'],
      example: ['FAKE_ONE'],
      readme: ['FAKE_ONE'],
    });
    expect(result.runtimeInCode).toEqual(['NODE_ENV', 'VERCEL_ENV']);
    expect(result.undocumentedInExample).toEqual([]);
    expect(result.hasDrift).toBe(false);
  });

  // A runtime-provided variable is documented in the README so the list is complete, and
  // deliberately left out of .env.example so nobody is invited to set it by hand. That
  // asymmetry is the correct state, not drift.
  it('does not flag a runtime-provided variable listed in the README but not in .env.example', () => {
    const result = analyse({
      code: ['FAKE_ONE', 'NODE_ENV'],
      example: ['FAKE_ONE'],
      readme: ['FAKE_ONE', 'NODE_ENV'],
    });
    expect(result.readmeNotInExample).toEqual([]);
    expect(result.runtimeInReadme).toEqual(['NODE_ENV']);
    expect(result.hasDrift).toBe(false);
  });

  it('still flags an application variable in the README but not in .env.example', () => {
    const result = analyse({
      code: ['FAKE_ONE'],
      example: [],
      readme: ['FAKE_ONE'],
    });
    expect(result.readmeNotInExample).toEqual(['FAKE_ONE']);
    expect(result.hasDrift).toBe(true);
  });
});

describe('RUNTIME_PROVIDED', () => {
  it('covers the platform-set variables this application reads', () => {
    expect(RUNTIME_PROVIDED.has('NODE_ENV')).toBe(true);
    expect(RUNTIME_PROVIDED.has('VERCEL_ENV')).toBe(true);
    expect(RUNTIME_PROVIDED.has('NODE_PATH')).toBe(true);
  });

  it('does not excuse an application variable from being documented', () => {
    expect(RUNTIME_PROVIDED.has('DATABASE_URL')).toBe(false);
    expect(RUNTIME_PROVIDED.has('AUTH_URL')).toBe(false);
  });
});

describe('scan scope', () => {
  it('matches the audit recipe in CLAUDE.md', () => {
    expect(SEARCH_PATHS).toEqual(['app', 'lib', 'components', 'auth.ts', 'next.config.ts']);
  });

  // scripts/ holds build tooling whose variables (APPDATA, NEXT_FORCE_LOCAL_DIST) are not
  // application configuration. Scanning it produced noise that trains people to ignore the
  // report, so it is deliberately out of scope.
  it('does not scan scripts/', () => {
    expect(SEARCH_PATHS).not.toContain('scripts');
  });

  // A test may set a throwaway env toggle that has no business in .env.example or the README.
  // Reporting it would block a push over a variable nobody should ever configure.
  it('excludes test files', () => {
    expect(EXCLUDE_PATHSPECS).toContain(':(exclude)**/*.test.ts');
    expect(EXCLUDE_PATHSPECS).toContain(':(exclude)**/*.test.tsx');
  });
});

describe('collectDynamicEnvVars', () => {
  // This repo reaches env vars through requireEnv('NAME') in lib/treasury/*. The dotted
  // regex cannot see those, so a new one added without a dotted reference would be drift
  // the script certified as IN SYNC.
  it('finds a requireEnv call', () => {
    expect(collectDynamicEnvVars("requireEnv('FAKE_ONE')")).toEqual(['FAKE_ONE']);
  });

  it('handles double and back quotes and whitespace', () => {
    expect(collectDynamicEnvVars('requireEnv( "FAKE_ONE" )')).toEqual(['FAKE_ONE']);
    expect(collectDynamicEnvVars('requireEnv(`FAKE_ONE`)')).toEqual(['FAKE_ONE']);
  });

  it('finds bracket indexing', () => {
    expect(collectDynamicEnvVars("process.env['FAKE_ONE']")).toEqual(['FAKE_ONE']);
    expect(collectDynamicEnvVars('process.env[ "FAKE_ONE" ]')).toEqual(['FAKE_ONE']);
  });

  it('ignores a computed key it cannot resolve', () => {
    expect(collectDynamicEnvVars('process.env[keyName]')).toEqual([]);
    expect(collectDynamicEnvVars('requireEnv(name)')).toEqual([]);
  });

  it('de-duplicates and sorts', () => {
    const source = "requireEnv('ZED'); process.env['ALPHA']; requireEnv('ZED');";
    expect(collectDynamicEnvVars(source)).toEqual(['ALPHA', 'ZED']);
  });
});
