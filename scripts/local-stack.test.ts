/**
 * local-stack.test.ts — the .env.local reader and writer in scripts/local-stack.mjs.
 *
 * This is the only part of the local stack that edits a file a developer owns, and that
 * file holds their real secrets. A wrong answer here does not fail loudly; it silently
 * changes which database the app talks to, or appends a duplicate key that overrides a
 * value the script promised never to touch.
 *
 * Every fixture is synthetic. The values are obvious placeholders, never real credentials.
 *
 * The rules being tested come from how `@next/env` actually parses these files:
 *   - `export NAME=`, `NAME:` and leading whitespace are all ACTIVE assignments
 *   - on a duplicate key the LAST one wins, so appending can override
 *   - a quoted value may span lines and may contain `#`, so a `# NAME=` inside one is
 *     not a comment
 */

import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyPorts,
  isLoopbackEndpoint,
  portMappingsFromDockerPorts,
  findEnvLines,
  readEnvValue,
  readPort,
  redactUrlCredentials,
  scanEnvFile,
  setEnvValue,
} from './local-stack.mjs';

const scan = (text: string) => scanEnvFile(text);

describe('portMappingsFromDockerPorts', () => {
  it('reads a single host-to-container mapping', () => {
    expect(portMappingsFromDockerPorts('0.0.0.0:16379->6379/tcp')).toEqual([
      { host: 16379, container: 6379 },
    ]);
  });

  it('expands a collapsed range, pairing host and container by offset', () => {
    expect(
      portMappingsFromDockerPorts('0.0.0.0:9000-9001->9000-9001/tcp'),
    ).toEqual([
      { host: 9000, container: 9000 },
      { host: 9001, container: 9001 },
    ]);
  });

  it('keeps the host and container sides aligned when the host range is shifted', () => {
    // This is the shape that makes a swap detectable: the host side moved, the container side
    // did not, so the mapping differs even though the host ports are the same two numbers.
    expect(portMappingsFromDockerPorts('0.0.0.0:19000-19001->9000-9001/tcp')).toEqual([
      { host: 19000, container: 9000 },
      { host: 19001, container: 9001 },
    ]);
  });

  it('returns nothing when the container publishes nothing', () => {
    expect(portMappingsFromDockerPorts('6379/tcp')).toEqual([]);
    expect(portMappingsFromDockerPorts('')).toEqual([]);
  });

  it('does not expand a reversed range', () => {
    expect(portMappingsFromDockerPorts('0.0.0.0:9001-9000->9000/tcp')).toEqual([
      { host: 9001, container: 9000 },
    ]);
  });

  it('keeps both endpoints of an absurdly wide range instead of expanding it', () => {
    // Expanding would add tens of thousands of entries. Keeping the endpoints means a clash on
    // one of THOSE is attributed to the right container rather than mis-reported as a
    // non-Docker process.
    expect(portMappingsFromDockerPorts('0.0.0.0:1-65535->1-65535/tcp')).toEqual([
      { host: 1, container: 1 },
      { host: 65535, container: 65535 },
    ]);
  });
});

describe('scanEnvFile', () => {
  it('accepts the real .env.example, which is full of apostrophes in comments', () => {
    // The must-accept fixture. .env.example is what a fresh machine gets seeded from,
    // and it carries apostrophes inside full-line comments ("app's", "don't"). A naive
    // quote count would call it unbalanced, refuse to edit the seeded file, and leave a
    // new machine configured with nothing.
    const text = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
    expect(scan(text).unbalanced).toBe(false);
  });

  it('does not treat an apostrophe in a comment as an open quote', () => {
    expect(scan("# this app's setting\nA=1\n").unbalanced).toBe(false);
  });

  it('closes a quoted value that opens and closes on one line', () => {
    expect(scan('A="one line"\nB=2\n').unbalanced).toBe(false);
  });

  it('reports an unclosed quoted value', () => {
    expect(scan('A="never closed\nB=2\n').unbalanced).toBe(true);
  });

  it('tracks a single-quoted value that never closes', () => {
    // The implementation branches on which quote character opened the value; only the
    // double-quote branch was exercised before.
    expect(scan("A='never closed\nB=2\n").unbalanced).toBe(true);
    expect(scan("A='one line'\nB=2\n").unbalanced).toBe(false);
  });

  it('ignores an active-looking assignment inside an open quoted value', () => {
    const result = scan('MULTI="line one\nS3_BUCKET=trap\nstill inside"\nC=3\n');
    expect(result.unbalanced).toBe(false);
    expect(readEnvValue(result, 'S3_BUCKET')).toBeNull();
    expect(findEnvLines(result, 'S3_BUCKET').shadowed).toEqual([1]);
  });

  it('knows a commented key inside an open quoted value is not a comment', () => {
    const result = scan('A="line one\n# B=2\nstill inside"\nC=3\n');
    expect(result.unbalanced).toBe(false);
    expect(result.insideQuote[1]).toBe(true);
    expect(readEnvValue(result, 'B')).toBeNull();
  });
});

describe('readEnvValue', () => {
  it('reads a plain assignment', () => {
    expect(readEnvValue(scan('DATABASE_URL=postgres://x\n'), 'DATABASE_URL')).toBe(
      'postgres://x',
    );
  });

  it('reads an assignment with an export prefix', () => {
    expect(readEnvValue(scan('export S3_BUCKET=my-bucket\n'), 'S3_BUCKET')).toBe('my-bucket');
  });

  it('reads the colon form', () => {
    expect(readEnvValue(scan('S3_REGION: eu-west-1\n'), 'S3_REGION')).toBe('eu-west-1');
  });

  it('reads an indented assignment', () => {
    expect(readEnvValue(scan('   REDIS_URL=redis://x\n'), 'REDIS_URL')).toBe('redis://x');
  });

  it('returns the last of two assignments, because that is the one that wins', () => {
    expect(readEnvValue(scan('A=first\nA=second\n'), 'A')).toBe('second');
  });

  it('returns null for a key that is only present commented out', () => {
    expect(readEnvValue(scan('# AWS_ACCESS_KEY_ID=\n'), 'AWS_ACCESS_KEY_ID')).toBeNull();
  });

  it('treats an inline hash comment as an empty value, the way dotenv does', () => {
    // `NAME=  # fill me in` is the empty string to @next/env. Reading it as the literal
    // "# fill me in" made the script think the key was set and skip the write, leaving the app
    // with no database and a report claiming otherwise.
    expect(readEnvValue(scan('DATABASE_URL=  # fill me in\n'), 'DATABASE_URL')).toBe('');
  });

  it('keeps a hash that is inside a quoted value, and strips the quotes like dotenv', () => {
    // Verified against @next/env: `A="value # not a comment"` yields the value WITHOUT the
    // quotes. Returning them attached sent `"my-bucket"` to ensureBucket as a bucket name.
    expect(readEnvValue(scan('A="value # not a comment"\n'), 'A')).toBe('value # not a comment');
  });

  it('discards an inline comment that follows a quoted value', () => {
    // Cutting only a matched leading/trailing pair missed this form, so
    // `S3_BUCKET="my-bucket" # note` reached the bucket check as an invalid name and the failure
    // was reported as "could not reach MinIO". Measured: dotenv gives `my-bucket`.
    expect(readEnvValue(scan('S3_BUCKET="my-bucket" # shared playground\n'), 'S3_BUCKET'))
      .toBe('my-bucket');
  });

  it('strips a matched quote pair, and reads an empty quoted value as empty', () => {
    expect(readEnvValue(scan('S3_BUCKET="my-bucket"\n'), 'S3_BUCKET')).toBe('my-bucket');
    expect(readEnvValue(scan("S3_BUCKET='my-bucket'\n"), 'S3_BUCKET')).toBe('my-bucket');
    // `Q=""` used to read as the two-character string `""` — non-empty, so `kept`, while the
    // app saw an empty value.
    expect(readEnvValue(scan('Q=""\n'), 'Q')).toBe('');
  });

  it('does not treat a bare colon line as an assignment, because dotenv swallows the next line', () => {
    // Measured: `NOTE:` followed by `DATABASE_URL=postgres://real/db` makes @next/env assign
    // that whole next line to NOTE, so DATABASE_URL is NOT set for the app. Reading it as
    // active here reported a database the app did not have.
    const file = scan('NOTE:\nDATABASE_URL=postgres://real/db\n');
    expect(readEnvValue(file, 'NOTE')).toBeNull();
  });

  it('does not treat the colon form without trailing whitespace as an assignment', () => {
    // @next/env's dotenv regex is `(?:\s*=\s*?|:\s+?)` — the colon form needs whitespace
    // after it, so `NAME:value` is not an assignment there and must not be read as one here.
    expect(readEnvValue(scan('S3_REGION:nospace\n'), 'S3_REGION')).toBeNull();
    expect(readEnvValue(scan('S3_REGION: withspace\n'), 'S3_REGION')).toBe('withspace');
  });

  it('does not match a key that is merely a prefix of another', () => {
    expect(readEnvValue(scan('TOKEN_ENCRYPTION_KEY_PREVIOUS=old\n'), 'TOKEN_ENCRYPTION_KEY'))
      .toBeNull();
  });
});

describe('setEnvValue', () => {
  it('leaves an existing active value alone', () => {
    const file = scan('DATABASE_URL=postgres://somewhere-else/db\n');
    expect(setEnvValue(file, 'DATABASE_URL', 'postgres://localhost/new')).toBe('kept');
    expect(file.lines.join('\n')).toContain('somewhere-else');
  });

  it('leaves an export-prefixed value alone instead of appending a winning duplicate', () => {
    // The specific bug this rule exists for: a bare `NAME=` scan misses
    // `export NAME=`, appends a second line, and the appended line wins.
    const file = scan('export DATABASE_URL=postgres://somewhere-else/db\n');
    expect(setEnvValue(file, 'DATABASE_URL', 'postgres://localhost/new')).toBe('kept');
    const text = file.lines.join('\n');
    expect(text).toContain('somewhere-else');
    expect(text).not.toContain('postgres://localhost/new');
  });

  it('leaves a colon-form value alone', () => {
    const file = scan('S3_REGION: us-east-1\n');
    expect(setEnvValue(file, 'S3_REGION', 'eu-west-1')).toBe('kept');
    expect(file.lines.join('\n')).toContain('us-east-1');
  });

  it('rewrites a commented key in place rather than appending a second one', () => {
    const file = scan('# AWS_ACCESS_KEY_ID=\nOTHER=1\n');
    expect(setEnvValue(file, 'AWS_ACCESS_KEY_ID', 'minioadmin')).toBe('replaced');
    const lines = file.lines.filter((l) => /AWS_ACCESS_KEY_ID/.test(l));
    expect(lines).toEqual(['AWS_ACCESS_KEY_ID=minioadmin']);
  });

  it('rewrites a commented key with no space after the hash', () => {
    const file = scan('#S3_ENDPOINT=\n');
    expect(setEnvValue(file, 'S3_ENDPOINT', 'http://localhost:9000')).toBe('replaced');
    expect(file.lines[0]).toBe('S3_ENDPOINT=http://localhost:9000');
  });

  it('fills in a key that is present but empty', () => {
    const file = scan('AUTH_SECRET=\n');
    expect(setEnvValue(file, 'AUTH_SECRET', 'generated')).toBe('replaced');
    expect(file.lines[0]).toBe('AUTH_SECRET=generated');
  });

  it('appends a key that is absent entirely', () => {
    const file = scan('EXISTING=1\n');
    expect(setEnvValue(file, 'REDIS_URL', 'redis://localhost:16379')).toBe('appended');
    expect(file.lines.join('\n')).toContain('REDIS_URL=redis://localhost:16379');
  });

  it('refuses the file when the key is shadowed inside an open quoted value', () => {
    // Refusing here is FAIL-SAFE, not strictly necessary — and the reason first written here
    // was wrong. Measured against @next/env: in a BALANCED multi-line value the inner line is
    // swallowed and is not an assignment, so appending would have been correct for this exact
    // fixture. It refuses because the quote scanner is a heuristic that diverges from dotenv in
    // both directions (a re-opened quote, backtick quoting), and when the two disagree the
    // script cannot know which key the app will actually see.
    const file = scan('A="line one\n# S3_ENDPOINT=trap\nstill inside"\n');
    const before = file.lines.join('\n');
    expect(setEnvValue(file, 'S3_ENDPOINT', 'http://localhost:9000')).toBe('ambiguous');
    expect(file.lines.join('\n')).toBe(before);
  });

  it('refuses a key assigned twice rather than choosing a line to overwrite', () => {
    // The data-loss case. readEnvValue reads the LAST assignment (correct — @next/env gives it
    // the win), while the writer used to rewrite the FIRST. On this input that destroyed a real
    // secret while the empty line kept winning, so the effective value did not even change.
    // .env.local is gitignored and has no backup.
    const file = scan('AUTH_SECRET=the-real-secret\nAUTH_SECRET=\n');
    const before = file.lines.join('\n');
    expect(setEnvValue(file, 'AUTH_SECRET', 'newly-generated')).toBe('ambiguous');
    expect(file.lines.join('\n')).toBe(before);
    expect(file.lines[0]).toBe('AUTH_SECRET=the-real-secret');
  });

  it('rewrites the last commented occurrence, so no duplicate key is created', () => {
    const file = scan('# S3_REGION=\nOTHER=1\n# S3_REGION=\n');
    expect(setEnvValue(file, 'S3_REGION', 'eu-west-1')).toBe('replaced');
    const assignments = file.lines.filter((l) => /S3_REGION/.test(l));
    expect(assignments).toEqual(['# S3_REGION=', 'S3_REGION=eu-west-1']);
    // The effective value is the last one, which is the one that was written.
    expect(readEnvValue(scan(file.lines.join('\n')), 'S3_REGION')).toBe('eu-west-1');
  });

  it('rewrites an empty commented colon-form placeholder in place', () => {
    const file = scan('# S3_REGION:\n');
    expect(setEnvValue(file, 'S3_REGION', 'eu-west-1')).toBe('replaced');
    expect(file.lines[0]).toBe('S3_REGION=eu-west-1');
  });

  it('never overwrites a commented line that carries text', () => {
    // A commented line with prose in it is documentation until proven otherwise. Replacing it
    // outright destroyed the note in a gitignored file with no backup, and the script reported
    // only "set in .env.local: DATABASE_URL". (dotenv, measured, WOULD read that line as an
    // assignment once uncommented — so the reason to leave it is not that it is inert, it is
    // that overwriting someone's prose is not this script's business.)
    const file = scan('# DATABASE_URL: the shared staging DB, ask someone\n');
    expect(setEnvValue(file, 'DATABASE_URL', 'postgres://localhost/x')).toBe('appended');
    expect(file.lines[0]).toBe('# DATABASE_URL: the shared staging DB, ask someone');
    expect(file.lines.join('\n')).toContain('DATABASE_URL=postgres://localhost/x');
  });

  it('rewrites a commented export-form key in place', () => {
    const file = scan('# export REDIS_URL=\n');
    expect(setEnvValue(file, 'REDIS_URL', 'redis://localhost:16379')).toBe('replaced');
    expect(file.lines[0]).toBe('REDIS_URL=redis://localhost:16379');
  });

  it('preserves a quoted value containing a hash', () => {
    const file = scan('A="value # not a comment"\n');
    expect(setEnvValue(file, 'B', '2')).toBe('appended');
    expect(file.lines[0]).toBe('A="value # not a comment"');
  });
});

describe('readPort', () => {
  const prev = process.env.FX_PG_PORT;
  afterEach(() => {
    if (prev === undefined) delete process.env.FX_PG_PORT;
    else process.env.FX_PG_PORT = prev;
  });

  it('falls back to the default when the override is unset', () => {
    delete process.env.FX_PG_PORT;
    expect(readPort('FX_PG_PORT', 5432)).toBe(5432);
  });

  it('reads a valid override', () => {
    process.env.FX_PG_PORT = '5433';
    expect(readPort('FX_PG_PORT', 5432)).toBe(5433);
  });

  it('returns null for anything that is not a usable port', () => {
    // Unvalidated, these became NaN or an out-of-range number, and the socket probe threw
    // ERR_SOCKET_BAD_PORT out of the script — a typo turning into a blocked `npm run dev`.
    for (const bad of ['abc', '0', '-1', '65536', '1.5', 'Infinity']) {
      process.env.FX_PG_PORT = bad;
      expect(readPort('FX_PG_PORT', 5432)).toBeNull();
    }
  });
});

describe('classifyPorts', () => {
  const PORTS = { postgres: 5432, redis: 16379, minio: 9000, minioConsole: 9001 };
  // Mirrors exactly what `publishedPorts()` puts in the map, including the container-side port —
  // "has this service moved?" is a question about the host->container mapping, so a fixture
  // without `container` would not be modelling the real input.
  const container = (
    project: string,
    service: string,
    containerPort: number,
    name = `${project}-${service}-1`,
  ) => ({ project, service, name, container: containerPort });

  it('treats our own project and service as ours, not a conflict', () => {
    const docker = new Map([[5432, container('fx-test-project', 'postgres', 5432)]]);
    const verdict = classifyPorts(PORTS, docker);
    expect(verdict.ours).toContain(5432);
    expect(verdict.foreign).toEqual([]);
  });

  it('reports another project holding the port, naming the project and service', () => {
    const docker = new Map([[16379, container('general-ledger', 'redis', 6379)]]);
    const verdict = classifyPorts(PORTS, docker);
    expect(verdict.foreign).toHaveLength(1);
    expect(verdict.foreign[0]).toContain('general-ledger');
    expect(verdict.foreign[0]).toContain('FX_REDIS_PORT');
  });

  it('reports our own project holding a port for a DIFFERENT service as foreign', () => {
    // Matching on the project alone would call this ours. It is not: redis's port is published
    // by our own postgres, and `up` would fail after the check had passed.
    //
    // The previous version of this test used `{ ...PORTS, redis: 5432 }`, which trips the
    // duplicate-override early return instead — so it asserted on `duplicates` while its name
    // claimed to cover this branch, and this branch had no coverage at all.
    const docker = new Map([[16379, container('fx-test-project', 'postgres', 5432)]]);
    const verdict = classifyPorts(PORTS, docker);
    expect(verdict.foreign).toHaveLength(1);
    expect(verdict.foreign[0]).toContain('service "postgres"');
    expect(verdict.foreign[0]).toContain('FX_REDIS_PORT');
    expect(verdict.ours).not.toContain(16379);
  });

  it('names the two overrides when they collide, instead of blaming a container', () => {
    const verdict = classifyPorts({ ...PORTS, minio: 16379 }, new Map());
    expect(verdict.duplicates).toHaveLength(1);
    expect(verdict.duplicates[0]).toContain('FX_MINIO_PORT');
    expect(verdict.duplicates[0]).toContain('FX_REDIS_PORT');
  });

  it('refuses to move a running service to a new host port', () => {
    // Compose would RECREATE the shared container, dropping the connections another checkout's
    // dev server is holding. The port being asked for is free, so nothing else would catch it.
    const docker = new Map([[5432, container('fx-test-project', 'postgres', 5432)]]);
    const verdict = classifyPorts({ ...PORTS, postgres: 5433 }, docker);
    expect(verdict.movedService).toHaveLength(1);
    expect(verdict.movedService[0]).toContain('RECREATE');
  });

  it('names the override that actually moved when only the console port changes', () => {
    // The owning key used to be resolved from the service name, and `find` returns `minio` for
    // both MinIO ports — so moving the CONSOLE port produced a message blaming FX_MINIO_PORT,
    // which had not changed and did ask for the port it was already on.
    const docker = new Map([
      [9000, container('fx-test-project', 'minio', 9000)],
      [9001, container('fx-test-project', 'minio', 9001)],
    ]);
    const verdict = classifyPorts({ ...PORTS, minioConsole: 9002 }, docker);
    expect(verdict.movedService).toHaveLength(1);
    expect(verdict.movedService[0]).toContain('FX_MINIO_CONSOLE_PORT');
  });

  it('catches a swap of a service\'s two ports instead of calling it ours', () => {
    // Both ports are still "in the wanted set", so a port-by-port check called this ours and
    // let Compose recreate the shared MinIO — the exact outcome the check exists to prevent.
    const docker = new Map([
      [9000, container('fx-test-project', 'minio', 9000)],
      [9001, container('fx-test-project', 'minio', 9001)],
    ]);
    const verdict = classifyPorts({ ...PORTS, minio: 9001, minioConsole: 9000 }, docker);
    expect(verdict.movedService).toHaveLength(1);
    expect(verdict.movedService[0]).toContain('RECREATE');
  });

  it('accepts a service whose host-to-container mapping is unchanged', () => {
    const docker = new Map([
      [9000, container('fx-test-project', 'minio', 9000)],
      [9001, container('fx-test-project', 'minio', 9001)],
      [5432, container('fx-test-project', 'postgres', 5432)],
    ]);
    const verdict = classifyPorts(PORTS, docker);
    expect(verdict.movedService).toEqual([]);
    expect(verdict.ours).toContain(9000);
    expect(verdict.ours).toContain(9001);
  });

  it('reports a free port as unknown, for the socket probe to check', () => {
    const verdict = classifyPorts(PORTS, new Map());
    expect(verdict.unknown.sort()).toEqual(['minio', 'minioConsole', 'postgres', 'redis']);
  });
});

describe('redactUrlCredentials', () => {
  it('masks the password in a connection string', () => {
    // predev prints this on every `npm run dev`, and the value is usually the developer's real
    // one because an active value is never overwritten. It must not reach scrollback or a log.
    const out = redactUrlCredentials('postgres://svc_fx:S3cret@pg.internal:5432/treasury');
    expect(out).not.toContain('S3cret');
    expect(out).toContain('pg.internal:5432');
    expect(out).toContain('treasury');
  });

  it('masks the username too, so it is not an account identifier in a log', () => {
    expect(redactUrlCredentials('postgres://svc_fx:pw@host/db')).not.toContain('svc_fx');
  });

  it('leaves a credential-free URL readable', () => {
    expect(redactUrlCredentials('redis://localhost:16379')).toBe('redis://localhost:16379');
    expect(redactUrlCredentials('http://localhost:9000')).toBe('http://localhost:9000');
  });

  it('masks a password carried as a query parameter', () => {
    // The CRITICAL case. `pg-connection-string`, which `pg` uses, honours `?password=`. Masking
    // only the userinfo left this fully exposed while the added `:***` made the output read as
    // though it had been redacted — worse than printing it plainly.
    const out = redactUrlCredentials(
      'postgresql://owner@ep-x.aws.example.tech/db?password=fake_scanner_safe_value&sslmode=require',
    );
    expect(out).not.toContain('fake_scanner_safe_value');
    expect(out).toContain('sslmode=require');
  });

  it('masks credentials in an S3 endpoint too', () => {
    const out = redactUrlCredentials('http://key:s3cret@minio.internal:9000');
    expect(out).not.toContain('s3cret');
    expect(out).toContain('minio.internal:9000');
  });

  it('does not invent a password where there is none', () => {
    const out = redactUrlCredentials('postgres://someuser@host:5432/db');
    expect(out).not.toContain(':***@');
    expect(out).toContain('s***');
  });

  it('hides anything unparseable that could carry a credential', () => {
    // Guessing where the secret ends in a malformed string is exactly where it would go wrong.
    expect(redactUrlCredentials('not a url but has:a@credential')).toBe('<set — value hidden>');
  });
});

describe('isLoopbackEndpoint', () => {
  it('accepts the local addresses the stack actually uses', () => {
    for (const url of [
      'http://localhost:9000',
      'http://127.0.0.1:9000',
      'http://[::1]:9000',
      'http://minio.localhost:9000',
    ]) {
      expect(isLoopbackEndpoint(url)).toBe(true);
    }
  });

  it('rejects anything that is not this machine', () => {
    // ensureBucket CREATES a bucket when one is missing and predev runs on every `npm run dev`,
    // so an S3_ENDPOINT left pointing at a shared store would get a CreateBucket from every
    // developer who starts the dev server.
    for (const url of [
      'https://s3.eu-west-1.amazonaws.com',
      'http://minio.internal:9000',
      'http://192.168.1.10:9000',
      'not-a-url',
    ]) {
      expect(isLoopbackEndpoint(url)).toBe(false);
    }
  });
});
