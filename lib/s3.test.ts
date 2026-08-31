import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  assertUnderPrefix,
  getS3Bucket,
  getS3Prefix,
  s3Key,
  safeFileName,
} from './s3';

describe('s3 key helpers', () => {
  const prev = {
    S3_BUCKET: process.env.S3_BUCKET,
    S3_PREFIX: process.env.S3_PREFIX,
    S3_REGION: process.env.S3_REGION,
    AWS_EC2_METADATA_DISABLED: process.env.AWS_EC2_METADATA_DISABLED,
  };

  beforeEach(() => {
    process.env.S3_BUCKET = 'deel-playgrounds-data';
    process.env.S3_PREFIX = 'fx-test-project/';
    process.env.S3_REGION = 'eu-west-1';
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
});
