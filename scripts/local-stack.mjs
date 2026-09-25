#!/usr/bin/env node
/**
 * Local development stack — Postgres, Redis and an S3-compatible store.
 *
 *   node scripts/local-stack.mjs up      # start, wait for health, configure .env.local
 *   node scripts/local-stack.mjs down    # stop (STACK-WIDE — see below)
 *   node scripts/local-stack.mjs status  # what is running, and what the app will actually talk to
 *
 * `npm run dev` runs `up` first through the `predev` script, so the stack starts
 * without a separate command.
 *
 * Three things in here are less obvious than they look, and each is a bug that
 * was found by measurement rather than by reading:
 *
 *   1. `docker compose version` exits 0 even when the daemon is dead — it is a
 *      client plugin. `docker info` is the probe that actually answers "can I
 *      run a container".
 *   2. Under Rancher Desktop every published container port is held by the Lima
 *      forwarder, so `lsof` reports `ssh` for all of them and cannot tell our
 *      Postgres from another project's Redis. Ownership comes from Docker's own
 *      compose labels; `lsof` is only used to name a NON-Docker holder.
 *   3. In `@next/env`, `export NAME=`, `NAME:` and leading whitespace are all
 *      active assignments, and on a duplicate key the LAST one wins. So an
 *      appended line silently overrides an earlier value — which is why the
 *      "never overwrite what is already set" rule below has to match all those
 *      forms rather than a bare `NAME=`.
 *
 * Failures are deliberately soft where the app can still run: this script must
 * never be the reason `npm run dev` refuses to start. It exits non-zero only
 * when Docker is up and the stack genuinely could not be brought up.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = 'fx-test-project';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read a host port override: the default when unset, the number when valid, `null` when the
 * value is set but unusable.
 *
 * The `null` is load-bearing — `up()` bails on it with a message. Unvalidated, `FX_PG_PORT=abc`
 * became NaN and `portInUse(NaN)` threw ERR_SOCKET_BAD_PORT out through `up()`, turning one typo
 * into a stack trace and a blocked `npm run dev`.
 *
 * @param {string} name
 * @param {number} fallback
 */
export function readPort(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/** Host ports, overridable so a machine with a conflict can still run the stack. */
const PORTS = {
  postgres: readPort('FX_PG_PORT', 5432),
  redis: readPort('FX_REDIS_PORT', 16379),
  minio: readPort('FX_MINIO_PORT', 9000),
  minioConsole: readPort('FX_MINIO_CONSOLE_PORT', 9001),
};

/**
 * Which compose service legitimately owns each port we ask for.
 *
 * Keyed by the PORTS key, NOT by the port number: keying by port number breaks
 * the moment two entries resolve to the same port (`FX_REDIS_PORT=5432`), because
 * the later key silently overwrites the earlier one and the check then reports a
 * conflict against our own healthy container.
 */
const OWNER_SERVICE = {
  postgres: 'postgres',
  redis: 'redis',
  minio: 'minio',
  minioConsole: 'minio',
};

/**
 * The container-side port each entry maps to, from `docker-compose.yml`.
 *
 * Needed because "has this service moved?" is a question about the host→container MAPPING, not
 * about the set of host ports. Swapping MinIO's two ports leaves the host set identical while
 * changing `9000->9000` into `9001->9000` — a different mapping, a different Compose config
 * hash, and a silent recreate of the shared container.
 */
const CONTAINER_PORT = {
  postgres: 5432,
  redis: 6379,
  minio: 9000,
  minioConsole: 9001,
};

const MINIO_USER = 'minioadmin';
const MINIO_PASSWORD = 'minioadmin';

const say = (msg) => process.stdout.write(`[stack] ${msg}\n`);
/** Diagnostics go to stderr so they can be separated from the report on stdout. */
const warn = (msg) => process.stderr.write(`[stack] ${msg}\n`);

/* ------------------------------------------------------------------ docker -- */

function dockerAvailable() {
  try {
    // NOT `docker compose version`: that is a client plugin and exits 0 with a
    // dead daemon, which would let `up` fail later and take `npm run dev` with
    // it. `docker info` talks to the daemon.
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

function compose(args, opts = {}) {
  return execFileSync('docker', ['compose', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    ...opts,
  });
}

/**
 * Host-side ports out of one `docker ps` Ports field.
 *
 * Docker COLLAPSES consecutive ports into a range, so MinIO's two published
 * ports arrive as `0.0.0.0:9000-9001->9000-9001/tcp` and not as two entries.
 * Reading only the single-port form made this script report our own MinIO as a
 * foreign holder on the second run and exit 1 — which would have blocked
 * `npm run dev` from then on.
 *
 * @param {string} ports e.g. "0.0.0.0:9000-9001->9000-9001/tcp, [::]:9000-9001->9000-9001/tcp"
 * @returns {number[]}
 */
export function portMappingsFromDockerPorts(ports) {
  const found = [];
  for (const match of (ports || '').matchAll(
    /(?:^|,\s*)(?:[\d.]+|\[[^\]]+\]):(\d+)(?:-(\d+))?->(\d+)/g,
  )) {
    const hostFrom = Number(match[1]);
    const hostTo = match[2] ? Number(match[2]) : hostFrom;
    const contFrom = Number(match[3]);
    if (!Number.isFinite(hostFrom) || !Number.isFinite(contFrom)) continue;
    if (hostTo < hostFrom) {
      found.push({ host: hostFrom, container: contFrom });
      continue;
    }
    // A range this wide is not a real service mapping and expanding it would add tens of
    // thousands of entries. Keep both ENDPOINTS so a clash on one of those is attributed to the
    // right container instead of being mis-reported as a non-Docker process. A port in the
    // middle still falls through to the socket probe, which is wrong but is the lesser problem.
    if (hostTo - hostFrom > 1024) {
      found.push({ host: hostFrom, container: contFrom });
      found.push({ host: hostTo, container: contFrom + (hostTo - hostFrom) });
      continue;
    }
    for (let offset = 0; hostFrom + offset <= hostTo; offset += 1) {
      found.push({ host: hostFrom + offset, container: contFrom + offset });
    }
  }
  return found;
}

/**
 * Published host ports mapped to the container publishing them.
 *
 * @returns {Map<number, {project: string, service: string, name: string, container: number}>}
 */
function publishedPorts() {
  const map = new Map();
  let out = '';
  try {
    out = execFileSync(
      'docker',
      [
        'ps',
        '--format',
        '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Ports}}',
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
  } catch {
    return map;
  }
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, project, service, ports = ''] = line.split('\t');
    for (const { host, container } of portMappingsFromDockerPorts(ports)) {
      map.set(host, { project, service, name, container });
    }
  }
  return map;
}

/** True when something is accepting connections on this host port. */
function portInUse(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Best-effort name for a non-Docker process holding a port. */
function nonDockerHolder(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const row = out.split('\n')[1] || '';
    const [command, pid] = row.trim().split(/\s+/);
    return command ? `${command} (pid ${pid})` : 'an unknown process';
  } catch {
    return 'an unknown process';
  }
}

const OVERRIDE_VAR = {
  postgres: 'FX_PG_PORT',
  redis: 'FX_REDIS_PORT',
  minio: 'FX_MINIO_PORT',
  minioConsole: 'FX_MINIO_CONSOLE_PORT',
};

/**
 * Decide, for each wanted port, whether it is ours, free, or someone else's.
 *
 * Pure so it can be tested: this is the logic that has already been wrong twice — once reading a
 * collapsed `9000-9001` range as a single port, and once keying the owner map by port number so
 * two services wanting one port made the check report our own healthy container as foreign.
 *
 * A port is OURS only when the same compose project AND the same service publishes it. Matching
 * the project alone is too loose: `FX_REDIS_PORT=5432` is held by our own *postgres*, would pass
 * a project-level check, and would then fail inside `up`.
 *
 * @param {Record<string, number>} wanted        PORTS-shaped map of key → host port
 * @param {Map<number, {project: string, service: string, name: string, container: number}>} docker
 * @returns {{duplicates: string[], foreign: string[], ours: number[], unknown: string[],
 *            movedService: string[]}}
 */
export function classifyPorts(wanted, docker) {
  const duplicates = [];
  const foreign = [];
  const ours = [];
  const unknown = [];
  const movedService = [];

  const seen = new Map();
  for (const [key, port] of Object.entries(wanted)) {
    if (seen.has(port)) {
      duplicates.push(
        `${OVERRIDE_VAR[key]} and ${OVERRIDE_VAR[seen.get(port)]} both ask for port ${port}. `
          + 'Each service needs its own host port.',
      );
      continue;
    }
    seen.set(port, key);
  }
  if (duplicates.length) return { duplicates, foreign, ours, unknown, movedService };

  // A container of ours already running on a DIFFERENT set of host ports than the one now
  // requested. Compose would silently RECREATE it, dropping the connections another checkout's
  // dev server is holding. Verified with `docker compose --dry-run`: a changed published port
  // prints "Recreate", an unchanged one prints "Running".
  //
  // The comparison is per SERVICE over its whole published set, not port by port. A service can
  // publish several ports (minio publishes two), and two facts follow that a port-by-port check
  // gets wrong: the owning key cannot be found from the service name alone — `Object.keys().find`
  // returns `minio` for the console port too and then names the wrong override — and swapping a
  // service's two ports leaves every individual port still "in the wanted set", so the swap
  // sailed through as ours and the recreate happened anyway.
  const runningByService = new Map();
  for (const [host, held] of docker) {
    if (held.project !== PROJECT) continue;
    if (!runningByService.has(held.service)) runningByService.set(held.service, new Set());
    runningByService.get(held.service).add(`${host}->${held.container ?? '?'}`);
  }
  for (const [service, running] of runningByService) {
    const keys = Object.keys(wanted).filter((k) => OWNER_SERVICE[k] === service);
    if (keys.length === 0) continue;
    const asked = new Set(keys.map((k) => `${wanted[k]}->${CONTAINER_PORT[k]}`));
    const same = asked.size === running.size && [...asked].every((m) => running.has(m));
    if (same) continue;
    // Name only the overrides that actually differ, so the message does not blame a variable
    // the person never set.
    const moved = keys.filter((k) => !running.has(`${wanted[k]}->${CONTAINER_PORT[k]}`));
    const overrides = (moved.length ? moved : keys).map((k) => OVERRIDE_VAR[k]).join(' / ');
    movedService.push(
      `${service} is already running as ${[...running].sort().join(', ')}, but this run asks for `
        + `${[...asked].sort().join(', ')}. Starting it would RECREATE the shared container and `
        + `drop every other checkout's connections. Unset ${overrides}, or stop the stack first.`,
    );
  }

  for (const [key, port] of Object.entries(wanted)) {
    const held = docker.get(port);
    if (!held) {
      unknown.push(key);
      continue;
    }
    if (held.project === PROJECT && held.service === OWNER_SERVICE[key]) {
      ours.push(port);
      continue;
    }
    const who = held.project
      ? `container ${held.name} (compose project "${held.project}", service "${held.service}")`
      : `container ${held.name}`;
    foreign.push(
      `port ${port} (${key}) is published by ${who}. `
        + `Set ${OVERRIDE_VAR[key]} to a free port, or stop that container.`,
    );
  }
  return { duplicates, foreign, ours, unknown, movedService };
}

/**
 * Everything blocking the stack from starting, as messages.
 *
 * @returns {Promise<string[]>} empty means clear to start
 */
async function portConflicts() {
  const verdict = classifyPorts(PORTS, publishedPorts());
  if (verdict.duplicates.length) return verdict.duplicates;
  const problems = [...verdict.movedService, ...verdict.foreign];

  for (const key of verdict.unknown) {
    const port = PORTS[key];
    // Compose publishes on IPv4 and IPv6; either being taken breaks `up`.
    const busy = (await portInUse(port, '127.0.0.1')) || (await portInUse(port, '::1'));
    if (busy) {
      problems.push(
        `port ${port} (${key}) is held by ${nonDockerHolder(port)}, which is not a Docker `
          + `container. Set ${OVERRIDE_VAR[key]} to a free port, or stop that process.`,
      );
    }
  }
  return problems;
}

/* ------------------------------------------------------------- .env.local -- */

/**
 * Split an env file into lines, marking which ones are inside an open quoted
 * value. A quoted value may legally span lines and legally contain `#`, so a
 * `# NAME=` sitting inside one is not a comment and must never be rewritten.
 *
 * @param {string} text
 * @returns {{lines: string[], insideQuote: boolean[], unbalanced: boolean}}
 */
export function scanEnvFile(text) {
  const lines = text.split('\n');
  const insideQuote = [];
  let open = null; // the quote character we are waiting to close

  for (const line of lines) {
    insideQuote.push(open !== null);
    if (open !== null) {
      if (line.includes(open)) open = null;
      continue;
    }
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const assignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*[:=]\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const value = assignment[1];
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : null;
    // A one-line quoted value closes on the same line: `K="v"` has 2 quotes.
    if (quote && value.split(quote).length < 3) open = quote;
  }
  return { lines, insideQuote, unbalanced: open !== null };
}

// `NAME=`, `export NAME=` and `NAME: value` are all active in @next/env, whose dotenv regex is
// `(?:\s*=\s*?|:\s+?)` — so the colon form needs whitespace after the colon and `NAME:value`
// is not an assignment at all.
//
// The colon form additionally requires a NON-WHITESPACE remainder on the same line. Measured:
// a bare `NOTE:` followed by `DATABASE_URL=postgres://real/db` makes dotenv swallow the next
// line as NOTE's value, so DATABASE_URL is NOT set for the app — while a looser pattern here
// read it as active and reported a database the app did not have.
const ASSIGNMENT = '(?:=|:\\s+\\S)';
const activePattern = (name) =>
  new RegExp(`^\\s*(?:export\\s+)?${name}\\s*${ASSIGNMENT}`);
const commentedPattern = (name) =>
  new RegExp(`^\\s*#\\s*(?:export\\s+)?${name}\\s*(?:=|:)`);

/**
 * A commented line whose value part is EMPTY — `# NAME=` or `# NAME:`.
 *
 * Only these are rewritten in place. A commented line that carries text is left exactly as it
 * is and the value appended instead, because that text may be documentation rather than a
 * placeholder: `# DATABASE_URL: the shared staging DB, ask someone` was being replaced outright,
 * destroying the note in a gitignored file with no backup while the script reported only
 * "set in .env.local: DATABASE_URL".
 *
 * (dotenv, measured, *would* read that line as an assignment once uncommented — so the reason to
 * leave it alone is not that it is inert, it is that overwriting a person's prose is not this
 * script's business.)
 *
 * @param {string} line
 * @param {string} name
 */
function isEmptyCommentedAssignment(line, name) {
  const match = new RegExp(`^\\s*#\\s*(?:export\\s+)?${name}\\s*(?:=|:)\\s*(.*)$`).exec(line);
  return match !== null && match[1].trim() === '';
}

/**
 * Strip an unquoted trailing `# comment` from a value, the way dotenv does.
 *
 * Without this, `DATABASE_URL=  # fill me in` reads as the value "# fill me in", looks set, and
 * the script skips the write — leaving the app with no database and a confident report saying
 * otherwise. @next/env gives that line the empty string.
 *
 * @param {string} raw
 */
function stripInlineComment(raw) {
  const value = raw.trim();
  // A quoted value is unwrapped and anything after the closing quote discarded, the way
  // dotenv's alternation does it. Returning the quotes attached meant
  // `S3_BUCKET="my-bucket"` reached `ensureBucket` as `"my-bucket"` — an invalid bucket name
  // whose HeadBucket failure was then reported as "could not reach MinIO", so the bucket was
  // silently never created. Measured: `S3_BUCKET="my-bucket" # note` is `my-bucket` to dotenv,
  // and cutting only a matched leading/trailing pair missed exactly that form.
  for (const quote of ['"', "'", '`']) {
    if (!value.startsWith(quote)) continue;
    const close = value.indexOf(quote, 1);
    // No closing quote on this line: a multi-line value. Return it as-is; the caller decides.
    if (close === -1) return value;
    return value.slice(1, close);
  }
  const hash = value.indexOf('#');
  return hash === -1 ? value : value.slice(0, hash).trim();
}

/**
 * Every line index that assigns `name`, split by kind.
 *
 * `insideQuote` lines are reported separately and are the reason this returns three lists
 * rather than two: a line that LOOKS like an assignment but sits inside an open quoted value
 * is invisible to @next/env, and writing the key elsewhere would append a duplicate that wins.
 * The only safe response to that is to refuse.
 *
 * @param {{lines: string[], insideQuote: boolean[]}} scan
 * @param {string} name
 */
export function findEnvLines(scan, name) {
  const active = [];
  const commented = [];
  const shadowed = [];
  const activeRe = activePattern(name);
  const commentedRe = commentedPattern(name);
  scan.lines.forEach((line, i) => {
    const looksLikeKey = activeRe.test(line) || commentedRe.test(line);
    if (!looksLikeKey) return;
    if (scan.insideQuote[i]) shadowed.push(i);
    else if (activeRe.test(line)) active.push(i);
    else commented.push(i);
  });
  return { active, commented, shadowed };
}

/**
 * Read the value of an active assignment, or null when the key is absent or
 * only present commented out.
 *
 * @param {{lines: string[], insideQuote: boolean[]}} scan
 * @param {string} name
 */
export function readEnvValue(scan, name) {
  const { active } = findEnvLines(scan, name);
  if (active.length === 0) return null;
  // Duplicate keys: @next/env lets the LAST one win, so that is the effective value.
  const line = scan.lines[active[active.length - 1]];
  const raw = line.replace(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?:=|:\s+)\s*/, '');
  return stripInlineComment(raw);
}

/**
 * Set `name` to `value` unless it already has an active value.
 *
 * A commented `# NAME=` is rewritten IN PLACE rather than appended to, so the
 * file never ends up with two lines for one key.
 *
 * `'ambiguous'` means the file was NOT touched and a person has to look at it. Guessing is what
 * destroys data here: an earlier version replaced the FIRST matching line while `readEnvValue`
 * reads the LAST, so a file holding
 *
 *     AUTH_SECRET=the-real-secret
 *     AUTH_SECRET=
 *
 * had its real secret overwritten while the empty line kept winning — the value the app saw did
 * not even change. `.env.local` is gitignored and has no backup.
 *
 * @returns {'kept' | 'replaced' | 'appended' | 'ambiguous'}
 */
export function setEnvValue(scan, name, value) {
  const { active, commented, shadowed } = findEnvLines(scan, name);

  // A line matching this key sits inside what the scanner believes is an open quoted value.
  //
  // Refusing here is FAIL-SAFE, not strictly necessary: measured against @next/env, a *balanced*
  // multi-line value swallows the inner line, so it is not an assignment at all and appending
  // would have been correct. The reason to refuse anyway is that this scanner is a heuristic and
  // diverges from dotenv in both directions — `A="a"b"`, a re-opened quote, and a value quoted
  // with backticks all read differently here than there. When the two disagree, the script does
  // not know which key the app will actually see, and guessing is how a value gets written that
  // the app never reads.
  if (shadowed.length > 0) return 'ambiguous';

  // More than one active line for one key: the last wins, the others are dead, and we cannot
  // tell which one the person meant. Refuse rather than pick.
  if (active.length > 1) return 'ambiguous';

  if (active.length === 1) {
    const existing = readEnvValue(scan, name);
    if (existing !== null && existing !== '') return 'kept';
    scan.lines[active[0]] = `${name}=${value}`;
    return 'replaced';
  }

  // Rewrite the LAST empty commented placeholder in place, so no duplicate key is created.
  // A commented line carrying text is documentation until proven otherwise — leave it.
  const placeholders = commented.filter((i) => isEmptyCommentedAssignment(scan.lines[i], name));
  if (placeholders.length > 0) {
    scan.lines[placeholders[placeholders.length - 1]] = `${name}=${value}`;
    return 'replaced';
  }

  if (scan.lines.length && scan.lines[scan.lines.length - 1].trim() !== '') scan.lines.push('');
  scan.lines.push(`${name}=${value}`);
  return 'appended';
}

/** The main checkout's path, which differs from ROOT inside a git worktree. */
function mainCheckoutRoot() {
  try {
    const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    return path.dirname(path.resolve(ROOT, gitCommonDir));
  } catch {
    return ROOT;
  }
}

/**
 * Make sure `.env.local` exists, seeding it from the best available source.
 *
 * A worktree seeds from the main checkout, and the reason is specific:
 * every checkout now shares one Postgres volume, so a worktree holding a
 * different TOKEN_ENCRYPTION_KEY fails closed on every Treasury token already
 * stored there. That is correct behaviour with a baffling symptom.
 */
function ensureEnvLocal() {
  const target = path.join(ROOT, '.env.local');
  if (fs.existsSync(target)) return { path: target, seededFrom: null };

  const main = path.join(mainCheckoutRoot(), '.env.local');
  if (main !== target && fs.existsSync(main)) {
    fs.copyFileSync(main, target);
    return { path: target, seededFrom: 'the main checkout' };
  }
  fs.copyFileSync(path.join(ROOT, '.env.example'), target);
  return { path: target, seededFrom: '.env.example' };
}

/* -------------------------------------------------------------------- s3 --- */

/**
 * Create the bucket if it is missing.
 *
 * The bucket name comes from the EFFECTIVE S3_BUCKET after the .env.local
 * merge, not from a default: an existing active S3_BUCKET is never overwritten,
 * so a stack that created some other bucket would answer every write with
 * NoSuchBucket.
 */
async function ensureBucket(endpoint, bucket, region, credentials) {
  let sdk;
  try {
    sdk = await import('@aws-sdk/client-s3');
  } catch {
    warn('dependencies are not installed yet — run `npm install`, then `npm run stack:up`.');
    return false;
  }
  const { S3Client, HeadBucketCommand, CreateBucketCommand } = sdk;
  const client = new S3Client({ region, endpoint, forcePathStyle: true, credentials });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 403 || err?.name === 'Forbidden' || err?.name === 'AccessDenied') {
      warn(
        `MinIO rejected the credentials while checking bucket "${bucket}". The AWS_* values in `
          + '.env.local are not the ones MinIO accepts — comment them out so the stack can set '
          + 'them, or point S3_ENDPOINT at the store those credentials belong to.',
      );
      return false;
    }
    if (status !== 404 && err?.name !== 'NotFound' && err?.name !== 'NoSuchBucket') {
      warn(`could not reach MinIO to check bucket "${bucket}": ${err?.name || err}`);
      return false;
    }
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    say(`created bucket "${bucket}" in MinIO`);
    return true;
  } catch (err) {
    warn(`could not create bucket "${bucket}": ${err?.name || err}`);
    return false;
  }
}

/* ------------------------------------------------------------------ report -- */

/**
 * Replace the password in a connection string with `***`.
 *
 * A URL carries its password in the userinfo component, and this script's own default
 * (`postgres://postgres:postgres@…`) has that shape — but the value it prints is usually the
 * developer's REAL one, since an active value is never overwritten. `predev` runs on every dev
 * start, so an unmasked print lands in terminal scrollback, captured build logs and agent
 * transcripts. `check-security.md` section 1 and `check-financial.md` section 6 both forbid it.
 *
 * Anything unparseable is reported as `<set>` rather than echoed — a string that is not a valid
 * URL is exactly the case where guessing where the secret ends would be wrong.
 *
 * @param {string} value
 */
export function redactUrlCredentials(value) {
  try {
    const url = new URL(value);
    // A Postgres URI may carry its password as a QUERY PARAMETER, not in the userinfo, and
    // `pg-connection-string` (which `pg` uses) honours it. Masking only the userinfo left that
    // form fully exposed while the added `:***` made the output read as though it were redacted,
    // which is worse than printing it plainly.
    let redacted = false;
    for (const key of [...url.searchParams.keys()]) {
      if (/pass|pwd|secret|token|key|credential/i.test(key)) {
        url.searchParams.set(key, '***');
        redacted = true;
      }
    }
    if (url.password) {
      url.password = '***';
      redacted = true;
    }
    // Keep the first character of the username: telling `postgres` from `svc_fx` on the same
    // host is a question this report exists to answer, and a full mask also leaks its length.
    if (url.username) {
      url.username = `${url.username[0]}***`;
      redacted = true;
    }
    // Nothing to hide: return the value UNCHANGED. `url.toString()` normalises — it appends a
    // trailing slash, for one — and this report is supposed to show exactly what the app will
    // use, not a re-serialised version of it.
    return redacted ? url.toString() : value;
  } catch {
    return /[:@?=]/.test(value) ? '<set — value hidden>' : value;
  }
}

/**
 * True when the endpoint names this machine.
 *
 * `ensureBucket` CREATES a bucket when one is missing, and `predev` runs it on every
 * `npm run dev`. An `S3_ENDPOINT` left pointing at a shared or remote S3-compatible store would
 * therefore get a CreateBucket from every developer who starts the dev server. The variable is
 * documented as local-only in three places; this is the part that enforces it.
 *
 * @param {string} endpoint
 */
export function isLoopbackEndpoint(endpoint) {
  try {
    const { hostname } = new URL(endpoint);
    const host = hostname.replace(/^\[|\]$/g, '');
    return (
      host === 'localhost'
      || host === '::1'
      || host === '0.0.0.0'
      || /^127\./.test(host)
      || host.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

/**
 * Print what the app will ACTUALLY talk to.
 *
 * This exists because the most confusing possible outcome is a healthy local stack sitting idle
 * while a pre-existing DATABASE_URL points somewhere else.
 *
 * A variable already exported in the shell wins over .env.local, because Next.js does not
 * override what is already in the environment — so the shell is checked FIRST and the winning
 * source is named. Reporting only the file value is how that becomes an hour of confusion.
 */
function reportEffective(scan) {
  /**
   * What the app will actually see for `name`, and where it came from.
   *
   * `@next/env` skips a variable only when it is UNDEFINED in the environment, so an exported
   * empty string wins over .env.local and the app sees ''. Every reader below goes through this
   * one function: the four warnings each used to check a single source of their own, so a
   * shell-exported AWS_SESSION_TOKEN — the case that actually breaks MinIO, and the usual case,
   * since it comes from `aws sso login` — was never warned about, while a shell-exported
   * TOKEN_ENCRYPTION_KEY produced a false "not set".
   *
   * @param {string} name
   * @returns {{value: string, fromShell: boolean}}
   */
  const effective = (name) => {
    if (name in process.env) {
      return { value: (process.env[name] ?? '').trim(), fromShell: true };
    }
    const file = readEnvValue(scan, name);
    return { value: file === null ? '' : file, fromShell: false };
  };

  const show = (name, fallback = 'not set', { secret = false } = {}) => {
    const { value, fromShell } = effective(name);
    if (value === '') {
      return fromShell ? 'set but EMPTY in your shell, overriding .env.local' : fallback;
    }
    const shown = secret ? redactUrlCredentials(value) : value;
    return fromShell ? `${shown}   (from your shell, overriding .env.local)` : shown;
  };
  say('the app will use:');
  process.stdout.write(`         DATABASE_URL   ${show('DATABASE_URL', 'not set — browser-only persistence', { secret: true })}\n`);
  process.stdout.write(`         REDIS_URL      ${show('REDIS_URL', 'not set', { secret: true })}\n`);
  process.stdout.write(`         S3_ENDPOINT    ${show('S3_ENDPOINT', 'not set — real AWS S3', { secret: true })}\n`);
  process.stdout.write(`         S3_BUCKET      ${show('S3_BUCKET')}\n`);
  process.stdout.write(`         S3_PREFIX      ${show('S3_PREFIX')}\n`);
  process.stdout.write(`         S3_REGION      ${show('S3_REGION')}\n`);

  const sessionToken = effective('AWS_SESSION_TOKEN');
  if (sessionToken.value) {
    warn(
      `AWS_SESSION_TOKEN is set (${sessionToken.fromShell ? 'in your shell' : 'in .env.local'}). `
        + 'A temporary STS token alongside the minioadmin credentials makes MinIO reject every '
        + 'request — unset it for local S3.',
    );
  }
  const accessKey = effective('AWS_ACCESS_KEY_ID');
  if (accessKey.fromShell && accessKey.value) {
    warn(
      'AWS_ACCESS_KEY_ID is exported in your shell. Next.js does not override variables already '
        + 'in the environment, so those credentials win over .env.local and will be sent to '
        + 'MinIO, which rejects them. Unset it in this shell for local S3.',
    );
  }
  if (!effective('TOKEN_ENCRYPTION_KEY').value) {
    warn(
      'TOKEN_ENCRYPTION_KEY is not set — Treasury connect stays disabled. '
        + 'Generate one with: openssl rand -base64 32',
    );
  }
  if (!effective('GOOGLE_CLIENT_ID').value) {
    warn('GOOGLE_CLIENT_ID is not set — Google sign-in is unavailable; dev-login is offered.');
  }
}

function otherWorktrees() {
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    })
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .filter((dir) => path.resolve(dir) !== ROOT);
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------- up ---- */

async function up() {
  if (/^(1|true|yes|on)$/i.test(process.env.STACK_SKIP?.trim() || '')) {
    say('STACK_SKIP=1 — skipping the local stack.');
    return 0;
  }
  if (!dockerAvailable()) {
    warn('Docker is not running. Start Docker Desktop or Rancher Desktop, then:');
    warn('  npm run stack:up');
    warn('The app still runs without it — sandbox and desk state persist in the browser only.');
    return 0;
  }

  for (const [key, port] of Object.entries(PORTS)) {
    if (port === null) {
      warn(
        `${OVERRIDE_VAR[key]} is not a usable port number. Unset it, or set it to 1-65535. `
          + 'Skipping the local stack.',
      );
      return 0;
    }
  }

  const conflicts = await portConflicts();
  if (conflicts.length) {
    for (const problem of conflicts) warn(problem);
    // Soft, on purpose. This script must never be the reason `npm run dev` refuses to start —
    // and a conflict often does not even matter: a developer running their own Postgres on 5432
    // already has an active DATABASE_URL pointing at it, which is never overwritten, so the
    // container would have gone unused anyway.
    warn('skipping the local stack. The app still runs against whatever .env.local already says.');
    const existing = path.join(ROOT, '.env.local');
    if (fs.existsSync(existing)) reportEffective(scanEnvFile(fs.readFileSync(existing, 'utf8')));
    return 0;
  }

  say(`starting postgres, redis and minio (compose project "${PROJECT}")`);
  try {
    // Services are named explicitly: `--wait` over the whole project returns 1
    // the moment any one-shot container exits, even at 0 and even with every
    // long-running service healthy.
    compose(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres', 'redis', 'minio'], {
      stdio: 'inherit',
    });
  } catch {
    warn('docker compose could not bring the stack up — `npm run stack:status` shows the state.');
    warn('To start the dev server without it: STACK_SKIP=1 npm run dev');
    return 1;
  }

  const { path: envPath, seededFrom } = ensureEnvLocal();
  if (seededFrom === 'the main checkout') {
    say('created .env.local by COPYING it from the main checkout.');
    warn(
      'that copy includes its secrets (TOKEN_ENCRYPTION_KEY, OKTA_CLIENT_SECRET, AUTH_SECRET). '
        + 'It is needed because every checkout now shares one Postgres volume, and a different '
        + 'TOKEN_ENCRYPTION_KEY fails closed on every Treasury token already stored there. '
        + 'Delete this worktree\'s .env.local when you are done with it.',
    );
  } else if (seededFrom) {
    say(`created .env.local from ${seededFrom}`);
  }

  const scan = scanEnvFile(fs.readFileSync(envPath, 'utf8'));
  if (scan.unbalanced) {
    warn('.env.local has an unclosed quoted value — not editing it. Fix the quote, then re-run.');
    // Deliberately NOT printing the per-key report here. After an unclosed quote every later
    // line reads as quoted content, so the report would print "not set" for keys that are set
    // and fire spurious TOKEN_ENCRYPTION_KEY / GOOGLE_CLIENT_ID warnings. Measured: @next/env
    // parses that file fine and does set them.
    warn('skipping the effective-configuration report — the file cannot be read reliably.');
    return 0;
  }

  const changed = [];
  const ambiguous = [];
  const apply = (name, value) => {
    const outcome = setEnvValue(scan, name, value);
    if (outcome === 'ambiguous') ambiguous.push(name);
    else if (outcome !== 'kept') changed.push(name);
  };

  apply('DATABASE_URL', `postgres://postgres:postgres@localhost:${PORTS.postgres}/fx_test_project`);
  apply('REDIS_URL', `redis://localhost:${PORTS.redis}`);
  apply('S3_ENDPOINT', `http://localhost:${PORTS.minio}`);
  apply('S3_BUCKET', 'deel-playgrounds-data');
  apply('S3_PREFIX', 'fx-test-project/');
  apply('S3_REGION', 'eu-west-1');
  apply('AWS_ACCESS_KEY_ID', MINIO_USER);
  apply('AWS_SECRET_ACCESS_KEY', MINIO_PASSWORD);
  // AUTH_SECRET is the ONLY secret this script generates, and only when empty.
  // It is exactly what .env.example tells a person to do by hand, into a
  // gitignored file. TOKEN_ENCRYPTION_KEY is deliberately NOT generated:
  // inventing one would silently orphan every encrypted row already in the
  // shared database.
  apply('AUTH_SECRET', crypto.randomBytes(33).toString('base64'));

  if (changed.length) {
    fs.writeFileSync(envPath, scan.lines.join('\n'));
    say(`set in .env.local: ${changed.join(', ')}`);
  }
  if (ambiguous.length) {
    warn(
      `left alone in .env.local because the file is ambiguous there: ${ambiguous.join(', ')}. `
        + 'Each of those keys is either assigned twice, or sits inside an unclosed quoted value. '
        + 'Fix the file by hand — guessing which line you meant is how a secret gets destroyed.',
    );
  }

  const bucket = readEnvValue(scan, 'S3_BUCKET') || 'deel-playgrounds-data';
  const endpoint = readEnvValue(scan, 'S3_ENDPOINT');
  const region = readEnvValue(scan, 'S3_REGION') || 'eu-west-1';
  if (endpoint && !isLoopbackEndpoint(endpoint)) {
    warn(
      `S3_ENDPOINT points at ${endpoint}, which is not a local address. Not touching it: this `
        + 'script creates a bucket when one is missing, and doing that against a shared or '
        + 'remote store is not its business. Point S3_ENDPOINT at the local MinIO, or unset it '
        + 'to use real AWS S3.',
    );
  } else if (endpoint) {
    await ensureBucket(endpoint, bucket, region, {
      accessKeyId: readEnvValue(scan, 'AWS_ACCESS_KEY_ID') || MINIO_USER,
      secretAccessKey: readEnvValue(scan, 'AWS_SECRET_ACCESS_KEY') || MINIO_PASSWORD,
    });
  }

  reportEffective(scan);
  say('ready.');
  return 0;
}

/* ------------------------------------------------------------ down / status - */

function down() {
  if (!dockerAvailable()) {
    warn('Docker is not running — nothing to stop.');
    return 0;
  }
  const others = otherWorktrees();
  warn(`this stops the shared "${PROJECT}" stack for EVERY checkout, not just this one.`);
  if (others.length) {
    warn('other checkouts using it:');
    for (const dir of others) warn(`  ${dir}`);
  }
  warn('data volumes are KEPT by this command.');
  warn(
    'To wipe them: `docker compose down --volumes` — that destroys the Postgres and MinIO data '
      + 'for EVERY checkout listed above, including desk snapshots, leg-tape ticks and stored '
      + 'Treasury tokens. There is no undo.',
  );
  try {
    compose(['down'], { stdio: 'inherit' });
  } catch {
    return 1;
  }
  return 0;
}

function status() {
  if (!dockerAvailable()) {
    warn('Docker is not running.');
    return 0;
  }
  try {
    compose(['ps', '-a'], { stdio: 'inherit' });
  } catch {
    warn('docker compose ps failed.');
  }
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) {
    warn('.env.local does not exist yet — run `npm run stack:up`.');
    return 0;
  }
  reportEffective(scanEnvFile(fs.readFileSync(envPath, 'utf8')));
  return 0;
}

/* ------------------------------------------------------------------- main --- */

const COMMANDS = { up, down, status };

async function main() {
  const command = process.argv[2] || 'up';
  const handler = COMMANDS[command];
  if (!handler) {
    warn(`unknown command "${command}". Use: up | down | status`);
    process.exit(1);
  }
  try {
    process.exit((await handler()) ?? 0);
  } catch (err) {
    // Fail soft for the same reason as the no-Docker path: an unexpected throw here would
    // otherwise print a stack trace and block `npm run dev` over a problem in the tooling
    // rather than in the app.
    warn(`the local stack could not be configured: ${err?.message || err}`);
    warn('continuing — run `npm run stack:status` to see the state.');
    process.exit(command === 'up' ? 0 : 1);
  }
}

// Only run when invoked directly, so the exported helpers can be unit-tested.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

