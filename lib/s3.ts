/**
 * AWS S3 file storage for this playground.
 *
 * Bucket: deel-playgrounds-data (override with S3_BUCKET)
 * Prefix: fx-test-project/          (override with S3_PREFIX)
 * Region: eu-west-1                 (override with AWS_REGION / S3_REGION)
 *
 * Every key is forced under the configured prefix — writes outside that path
 * are rejected before they hit the API.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';

const DEFAULT_BUCKET = 'deel-playgrounds-data';
const DEFAULT_PREFIX = 'fx-test-project/';
const DEFAULT_REGION = 'eu-west-1';

function normalizePrefix(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+/, '');
  if (!trimmed) return DEFAULT_PREFIX;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export function getS3Bucket(): string {
  return (process.env.S3_BUCKET || DEFAULT_BUCKET).trim() || DEFAULT_BUCKET;
}

export function getS3Prefix(): string {
  return normalizePrefix(process.env.S3_PREFIX || DEFAULT_PREFIX);
}

export function getS3Region(): string {
  return (
    process.env.S3_REGION?.trim()
    || process.env.AWS_REGION?.trim()
    || DEFAULT_REGION
  );
}

export function isS3Configured(): boolean {
  // IRSA / ambient credentials in cluster; local can use AWS_* env vars.
  // Bucket + prefix alone are enough to attempt — SDK resolves credentials.
  return Boolean(getS3Bucket() && getS3Prefix());
}

let client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!client) {
    // This app's only supported credential sources are IRSA (in-cluster) and
    // static AWS_* env vars (local) — EC2 instance metadata is never valid
    // here, but the SDK's default provider chain still probes it last,
    // logging a noisy "MetadataLookupWarning" when the endpoint is
    // unreachable. Skip that probe unless something has explicitly opted
    // back in.
    if (process.env.AWS_EC2_METADATA_DISABLED === undefined) {
      process.env.AWS_EC2_METADATA_DISABLED = 'true';
    }
    client = new S3Client({ region: getS3Region() });
  }
  return client;
}

/**
 * Build a full object key under the playground prefix.
 * `relativeKey` must NOT start with `/` or contain `..`.
 */
export function s3Key(relativeKey: string): string {
  const clean = relativeKey
    .replace(/\\/g, '/')
    .replace(/\.\./g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!clean) {
    throw new Error('S3 key path is empty');
  }
  return `${getS3Prefix()}${clean}`;
}

/** Reject keys that escape the playground prefix (defence in depth). */
export function assertUnderPrefix(key: string): string {
  const prefix = getS3Prefix();
  if (!key.startsWith(prefix)) {
    throw new Error(
      `S3 key "${key}" is outside the allowed prefix "${prefix}"`,
    );
  }
  return key;
}

export interface UploadedObject {
  key: string;
  bucket: string;
  etag?: string;
}

export async function putS3Object(input: {
  relativeKey: string;
  body: Buffer | Uint8Array | string;
  contentType?: string;
  metadata?: Record<string, string>;
}): Promise<UploadedObject> {
  const key = assertUnderPrefix(s3Key(input.relativeKey));
  const bucket = getS3Bucket();
  const params: PutObjectCommandInput = {
    Bucket: bucket,
    Key: key,
    Body: input.body,
    ContentType: input.contentType,
    Metadata: input.metadata,
  };
  const result = await getS3Client().send(new PutObjectCommand(params));
  return { key, bucket, etag: result.ETag };
}

export async function getS3Object(relativeKey: string): Promise<{
  key: string;
  body: Uint8Array;
  contentType?: string;
}> {
  const key = assertUnderPrefix(s3Key(relativeKey));
  const result = await getS3Client().send(
    new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }),
  );
  const body = result.Body
    ? await result.Body.transformToByteArray()
    : new Uint8Array();
  return { key, body, contentType: result.ContentType };
}

export async function getS3ObjectText(relativeKey: string): Promise<string> {
  const { body } = await getS3Object(relativeKey);
  return Buffer.from(body).toString('utf8');
}

export async function deleteS3Object(relativeKey: string): Promise<void> {
  const key = assertUnderPrefix(s3Key(relativeKey));
  await getS3Client().send(
    new DeleteObjectCommand({ Bucket: getS3Bucket(), Key: key }),
  );
}

export interface ListedObject {
  key: string;
  /** Key relative to the playground prefix. */
  relativeKey: string;
  size?: number;
  lastModified?: string;
}

export async function listS3Objects(
  relativePrefix = '',
  maxKeys = 100,
): Promise<ListedObject[]> {
  const root = getS3Prefix();
  const trimmed = relativePrefix
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.\./g, '');
  const effectivePrefix = !trimmed
    ? root
    : assertUnderPrefix(
        trimmed.endsWith('/') ? `${root}${trimmed}` : s3Key(trimmed),
      );

  const result = await getS3Client().send(
    new ListObjectsV2Command({
      Bucket: getS3Bucket(),
      Prefix: effectivePrefix,
      MaxKeys: maxKeys,
    }),
  );

  return (result.Contents ?? [])
    .filter((o): o is typeof o & { Key: string } => Boolean(o.Key))
    .map(o => ({
      key: o.Key!,
      relativeKey: o.Key!.startsWith(root) ? o.Key!.slice(root.length) : o.Key!,
      size: o.Size,
      lastModified: o.LastModified?.toISOString(),
    }));
}

/** Sanitize a user-facing filename for use in an S3 key segment. */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() || 'file';
  // Replace each illegal character (not runs) so "!!" → "__".
  return base.replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 180);
}
