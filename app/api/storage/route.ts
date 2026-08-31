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

function emailSlug(email: string): string {
  return email.toLowerCase().replace(/[^a-z0-9@._-]+/g, '_').slice(0, 80);
}

/** GET — list under a relative prefix, or download one object by relative key. */
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
  const key = searchParams.get('key')?.trim() ?? '';
  const prefix = searchParams.get('prefix')?.trim() ?? '';

  try {
    if (key) {
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

    const objects = await listS3Objects(prefix, 200);
    return NextResponse.json({
      bucket: getS3Bucket(),
      prefix: getS3Prefix(),
      region: getS3Region(),
      objects,
    });
  } catch (err) {
    console.error('[api/storage] GET failed', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read S3' },
      { status: 500 },
    );
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

    const folderRaw = String(form.get('folder') ?? 'uploads').trim() || 'uploads';
    const folder = folderRaw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.\./g, '') || 'uploads';
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
    const relativeKey = `${folder}/${emailSlug(emailOrErr)}/${stamp}-${name}`;

    const uploaded = await putS3Object({
      relativeKey,
      body: bytes,
      contentType: file.type || 'application/octet-stream',
      metadata: {
        uploader: emailSlug(emailOrErr),
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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to upload to S3' },
      { status: 500 },
    );
  }
}

/** DELETE — remove an object by relative key. */
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
  const key = searchParams.get('key')?.trim() ?? '';
  if (!key) {
    return NextResponse.json({ error: 'Missing key' }, { status: 400 });
  }

  try {
    await deleteS3Object(key);
    return NextResponse.json({ ok: true, relativeKey: key });
  } catch (err) {
    console.error('[api/storage] DELETE failed', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete from S3' },
      { status: 500 },
    );
  }
}
