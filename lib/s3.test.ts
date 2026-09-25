import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  assertUnderPrefix,
  getS3Bucket,
  getS3Endpoint,
  getS3Prefix,
  s3Key,
  s3OwnerSegment,
  safeFileName,
} from './s3';

describe('s3 key helpers', () => {
  const prev = {
    S3_BUCKET: process.env.S3_BUCKET,
    S3_PREFIX: process.env.S3_PREFIX,
    S3_REGION: process.env.S3_REGION,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    AWS_EC2_METADATA_DISABLED: process.env.AWS_EC2_METADATA_DISABLED,
  };

  beforeEach(() => {
    process.env.S3_BUCKET = 'deel-playgrounds-data';
    process.env.S3_PREFIX = 'fx-test-project/';
    process.env.S3_REGION = 'eu-west-1';
    delete process.env.S3_ENDPOINT;
    delete process.env.AWS_EC2_METADATA_DISABLED;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults bucket and prefix', () => {
    expect(getS3Bucket()).toBe('deel-playgrounds-data');
    expect(getS3Prefix()).toBe('fx-test-project/');
  });

  it('normalizes prefix without trailing slash', () => {
    process.env.S3_PREFIX = 'fx-test-project';
    expect(getS3Prefix()).toBe('fx-test-project/');
  });

  it('builds keys under the playground prefix', () => {
    expect(s3Key('uploads/a.xlsx')).toBe('fx-test-project/uploads/a.xlsx');
  });

  it('strips path traversal from relative keys', () => {
    expect(s3Key('../secret.txt')).toBe('fx-test-project/secret.txt');
    expect(s3Key('/uploads/x.xlsx')).toBe('fx-test-project/uploads/x.xlsx');
  });

  it('rejects keys outside the prefix', () => {
    expect(() => assertUnderPrefix('other-app/file.txt')).toThrow(/outside/);
    expect(assertUnderPrefix('fx-test-project/uploads/x.xlsx')).toBe(
      'fx-test-project/uploads/x.xlsx',
    );
  });

  it('sanitizes filenames', () => {
    expect(safeFileName('../../evil name!!.xlsx')).toBe('evil name__.xlsx');
  });

  // getS3Client() caches its client in module state, so each case below
  // needs a fresh module instance — otherwise the second test would just
  // hit the cache and never re-run the env var guard it's testing.
  it('disables the EC2 instance metadata credential probe by default', async () => {
    vi.resetModules();
    const { getS3Client } = await import('./s3');
    getS3Client();
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true');
  });

  it('respects an explicit override instead of forcing a default', async () => {
    process.env.AWS_EC2_METADATA_DISABLED = 'false';
    vi.resetModules();
    const { getS3Client } = await import('./s3');
    getS3Client();
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('false');
  });

  it('reads no endpoint when S3_ENDPOINT is unset', () => {
    expect(getS3Endpoint()).toBeUndefined();
  });

  it('treats a blank or whitespace S3_ENDPOINT as unset', () => {
    process.env.S3_ENDPOINT = '   ';
    expect(getS3Endpoint()).toBeUndefined();
  });

  it('trims the endpoint it reads', () => {
    process.env.S3_ENDPOINT = '  http://localhost:9000 ';
    expect(getS3Endpoint()).toBe('http://localhost:9000');
  });

  // The production path. With S3_ENDPOINT unset the client must be built
  // exactly as it was before the variable existed: no endpoint override, and
  // NO path-style addressing. AWS uses virtual-host addressing, so leaking
  // forcePathStyle into the cluster would change how every request is
  // addressed against a real bucket.
  it('builds an AWS client with no endpoint and no path-style addressing', async () => {
    vi.resetModules();
    const { getS3Client } = await import('./s3');
    const client = getS3Client();
    expect(await client.config.endpoint?.()).toBeUndefined();
    expect(await client.config.forcePathStyle).toBeFalsy();
  });

  // The local path. MinIO has no per-bucket DNS, so an endpoint without path
  // style resolves to a hostname that does not exist.
  it('builds a path-style client when S3_ENDPOINT points at MinIO', async () => {
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    vi.resetModules();
    const { getS3Client } = await import('./s3');
    const client = getS3Client();
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe('localhost');
    expect(endpoint?.port).toBe(9000);
    expect(await client.config.forcePathStyle).toBe(true);
  });

  // The endpoint changes where requests go; it must not widen where they may
  // write. The prefix guard is the only thing keeping this app inside its own
  // path in a shared bucket.
  it('still confines keys to the prefix when an endpoint is set', () => {
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    expect(s3Key('../secret.txt')).toBe('fx-test-project/secret.txt');
    expect(() => assertUnderPrefix('other-app/file.txt')).toThrow(/outside/);
  });
});

describe('s3OwnerSegment', () => {
  it('keeps an email made only of safe characters exactly as the old slug had it', () => {
    expect(s3OwnerSegment('Desk.Ops@Example.com ')).toBe('desk.ops@example.com');
  });

  it('gives two emails that a replace-with-underscore slug merged two different segments', () => {
    // Old slug: both became "a_b@example.com".
    expect(s3OwnerSegment('a+b@example.com')).toBe('a%2Bb@example.com');
    expect(s3OwnerSegment('a_b@example.com')).toBe('a_b@example.com');
  });

  it('encodes a literal percent sign, so no email can spell another one\'s encoding', () => {
    // Lower-cased first ('B' → 'b'), then '%' → '%25'.
    expect(s3OwnerSegment('a%2Bb@example.com')).toBe('a%252bb@example.com');
    expect(s3OwnerSegment('a%2Bb@example.com')).not.toBe(s3OwnerSegment('a+b@example.com'));
  });

  it('never produces a path separator or a traversal segment', () => {
    expect(s3OwnerSegment('a/b@example.com')).toBe('a%2Fb@example.com');
    expect(s3OwnerSegment('a/../b@example.com')).not.toContain('/');
  });

  it('keeps an email with consecutive dots apart from the one s3Key would collapse it into', () => {
    // s3Key deletes every "..": a raw "a..b" segment would become "ab".
    expect(s3Key(`execution-journal/${s3OwnerSegment('a..b@example.com')}/x.json`))
      .not.toBe(s3Key(`execution-journal/${s3OwnerSegment('ab@example.com')}/x.json`));
    expect(s3Key(`execution-journal/${s3OwnerSegment('a...b@example.com')}/x.json`))
      .not.toBe(s3Key(`execution-journal/${s3OwnerSegment('a.b@example.com')}/x.json`));
  });

  it('does not truncate a long email, so two sharing a long prefix stay apart', () => {
    const base = `${'x'.repeat(90)}`;
    expect(s3OwnerSegment(`${base}1@example.com`)).not.toBe(s3OwnerSegment(`${base}2@example.com`));
  });
});
