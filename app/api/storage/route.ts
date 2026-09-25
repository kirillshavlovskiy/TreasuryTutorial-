import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';
import {
  deleteS3Object,
  getS3Bucket,
  getS3Object,
  getS3Prefix,
  getS3Region,
  isS3Configured,
  listS3Objects,
  putS3Object,
  s3OwnerSegment,
  safeFileName,
} from '@/lib/s3';

export const runtime = 'nodejs';

async function requireUserEmail(): Promise<string | NextResponse> {
  const session = await auth();
  const email = session?.user?.email?.trim() ?? '';
  if (!email || email === TEST_GUEST_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return email;
}

/**
 * Top-level folders the app writes itself. This gateway neither uploads into
 * them nor reads or deletes from them — the execution journal's matcher part
 * has exactly one writer, and a DELETE here would erase it.
 */
const RESERVED_FOLDERS = new Set(['db_backup', 'execution-journal']);
const FOLDER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Same normalisation `lib/s3.ts` applies before a key reaches the API. */
function normalizeRelative(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/\.\./g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '');
}

/**
 * Every object a user can reach sits at `{folder}/{emailSlug}/…` — the layout
 * POST writes. The slug must be a whole path segment: a bare string prefix
 * would let `a@x.com` reach `a@x.com.au`'s objects.
 */
function ownedSegments(relative: string, slug: string): string[] | null {
  const segments = relative.replace(/\/+$/, '').split('/');
  if (segments.length < 2 || !segments[0] || segments[1] !== slug) return null;
  if (RESERVED_FOLDERS.has(segments[0])) return null;
  return segments;
}

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: 'Forbidden — only your own objects are accessible' },
    { status: 403 },
  );
}

/**
 * GET — list under a relative prefix, or download one object by relative key.
 * Both are limited to the caller's own `{folder}/{emailSlug}/` space.
 */
export async function GET(request: Request) {
  const emailOrErr = await requireUserEmail();
  if (emailOrErr instanceof NextResponse) return emailOrErr;

  if (!isS3Configured()) {
    return NextResponse.json(
      { error: 'S3 is not configured', configured: false },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const key = normalizeRelative(searchParams.get('key')?.trim() ?? '');
  const prefix = normalizeRelative(searchParams.get('prefix')?.trim() ?? '');
  const slug = s3OwnerSegment(emailOrErr);

  try {
    if (key) {
      const segments = ownedSegments(key, slug);
      // A key names an object, so it needs a file segment after the slug.
      if (!segments || segments.length < 3) return forbidden();
      const obj = await getS3Object(key);
      return new NextResponse(Buffer.from(obj.body), {
        status: 200,
        headers: {
          'Content-Type': obj.contentType || 'application/octet-stream',
          'X-S3-Key': obj.key,
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const segments = ownedSegments(prefix, slug);
    if (!segments) return forbidden();
    // `{folder}/{slug}` alone gets its trailing slash so it lists that folder,
    // not every slug that merely starts with this one.
    const ownedPrefix = segments.length === 2 ? `${segments.join('/')}/` : prefix;
    const objects = await listS3Objects(ownedPrefix, 200);
    return NextResponse.json({
      bucket: getS3Bucket(),
      prefix: getS3Prefix(),
      region: getS3Region(),
      objects,
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NoSuchKey') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    console.error('[api/storage] GET failed', err);
    return NextResponse.json({ error: 'Failed to read S3' }, { status: 500 });
  }
}

/**
 * POST — upload a file (multipart/form-data).
 * Fields: file (required), folder (optional, default "uploads"),
 *         ccy (optional metadata), scopeId (optional metadata).
 * Stored at: fx-test-project/{folder}/{email}/{timestamp}-{filename}
 */
export async function POST(request: Request) {
  const emailOrErr = await requireUserEmail();
  if (emailOrErr instanceof NextResponse) return emailOrErr;

  if (!isS3Configured()) {
    return NextResponse.json(
      { error: 'S3 is not configured', configured: false },
      { status: 503 },
    );
  }

  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    }

    const folder = String(form.get('folder') ?? 'uploads').trim() || 'uploads';
    // One plain segment, so the key is always `{folder}/{you}/…` and GET /
    // DELETE can tell whose object it is from its second segment.
    if (!FOLDER_PATTERN.test(folder) || RESERVED_FOLDERS.has(folder)) {
      return NextResponse.json({ error: 'Invalid folder' }, { status: 400 });
    }
    const ccy = String(form.get('ccy') ?? '').trim().toUpperCase();
    const scopeId = String(form.get('scopeId') ?? '').trim();

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength === 0) {
      return NextResponse.json({ error: 'Empty file' }, { status: 400 });
    }
    // 25 MB soft
    if (bytes.byteLength > 25 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large (max 25MB)' }, { status: 413 });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = safeFileName(file.name || 'upload.bin');
    const relativeKey = `${folder}/${s3OwnerSegment(emailOrErr)}/${stamp}-${name}`;

    const uploaded = await putS3Object({
      relativeKey,
      body: bytes,
      contentType: file.type || 'application/octet-stream',
      metadata: {
        uploader: s3OwnerSegment(emailOrErr),
        ...(ccy ? { ccy } : {}),
        ...(scopeId ? { scope: scopeId.slice(0, 64) } : {}),
        original: name.slice(0, 180),
      },
    });

    return NextResponse.json({
      ok: true,
      bucket: uploaded.bucket,
      key: uploaded.key,
      relativeKey,
      etag: uploaded.etag,
      size: bytes.byteLength,
      contentType: file.type || 'application/octet-stream',
    });
  } catch (err) {
    console.error('[api/storage] POST failed', err);
    return NextResponse.json({ error: 'Failed to upload to S3' }, { status: 500 });
  }
}

/** DELETE — remove one of the caller's own objects by relative key. */
export async function DELETE(request: Request) {
  const emailOrErr = await requireUserEmail();
  if (emailOrErr instanceof NextResponse) return emailOrErr;

  if (!isS3Configured()) {
    return NextResponse.json(
      { error: 'S3 is not configured', configured: false },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const key = normalizeRelative(searchParams.get('key')?.trim() ?? '');
  if (!key) {
    return NextResponse.json({ error: 'Missing key' }, { status: 400 });
  }
  const segments = ownedSegments(key, s3OwnerSegment(emailOrErr));
  if (!segments || segments.length < 3) return forbidden();

  try {
    await deleteS3Object(key);
    return NextResponse.json({ ok: true, relativeKey: key });
  } catch (err) {
    console.error('[api/storage] DELETE failed', err);
    return NextResponse.json({ error: 'Failed to delete from S3' }, { status: 500 });
  }
}
