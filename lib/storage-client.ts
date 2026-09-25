/**
 * Browser helper for the /api/storage S3 gateway.
 * Uploads always land under the server-enforced `fx-test-project/` prefix.
 */

export interface StorageUploadResult {
  ok: true;
  bucket: string;
  key: string;
  relativeKey: string;
  etag?: string;
  size: number;
  contentType: string;
}

export async function uploadToS3(
  file: File,
  opts?: { folder?: string; ccy?: string; scopeId?: string },
): Promise<StorageUploadResult> {
  const form = new FormData();
  form.append('file', file);
  if (opts?.folder) form.append('folder', opts.folder);
  if (opts?.ccy) form.append('ccy', opts.ccy);
  if (opts?.scopeId) form.append('scopeId', opts.scopeId);

  const res = await fetch('/api/storage', { method: 'POST', body: form });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    configured?: boolean;
  } & Partial<StorageUploadResult>;

  if (!res.ok) {
    if (res.status === 503 && body.configured === false) {
      throw new Error('S3 storage is not available in this environment');
    }
    throw new Error(body.error || `Upload failed (${res.status})`);
  }

  return body as StorageUploadResult;
}
