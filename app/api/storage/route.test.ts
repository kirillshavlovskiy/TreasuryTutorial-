import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';

const session: { email: string | null } = { email: 'desk@example.com' };
vi.mock('@/auth', () => ({
  auth: async () => (session.email ? { user: { email: session.email } } : null),
}));

const getS3Object = vi.fn(async (relativeKey: string) => ({
  key: `fx-test-project/${relativeKey}`,
  body: new TextEncoder().encode('ccy,rate\nEUR,1.17\n'),
  contentType: 'text/csv',
}));
const listS3Objects = vi.fn(async (_prefix: string, _maxKeys: number) => []);
const deleteS3Object = vi.fn(async (_relativeKey: string) => undefined);
const putS3Object = vi.fn(async (input: { relativeKey: string }) => ({
  key: `fx-test-project/${input.relativeKey}`,
  bucket: 'test-bucket',
  etag: '"etag"',
}));

// Keep the pure helpers (`safeFileName`) real; replace everything that
// would reach a bucket.
vi.mock('@/lib/s3', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/s3')>();
  return {
    ...actual,
    isS3Configured: () => true,
    getS3Bucket: () => 'test-bucket',
    getS3Prefix: () => 'fx-test-project/',
    getS3Region: () => 'us-east-1',
    getS3Object,
    listS3Objects,
    deleteS3Object,
    putS3Object,
  };
});

const { GET, POST, DELETE } = await import('@/app/api/storage/route');

function url(query: Record<string, string>): string {
  return `http://localhost/api/storage?${new URLSearchParams(query).toString()}`;
}

function getKey(key: string): Request {
  return new Request(url({ key }));
}

function getPrefix(prefix: string): Request {
  return new Request(url({ prefix }));
}

function del(key: string): Request {
  return new Request(url({ key }), { method: 'DELETE' });
}

function upload(folder: string | null): Request {
  const form = new FormData();
  form.append('file', new File(['ccy,rate\nEUR,1.17\n'], 'rates.csv', { type: 'text/csv' }));
  if (folder !== null) form.append('folder', folder);
  return new Request('http://localhost/api/storage', { method: 'POST', body: form });
}

function noSuchKey(): Error {
  const err = new Error('The specified key does not exist.');
  err.name = 'NoSuchKey';
  return err;
}

beforeEach(() => {
  session.email = 'desk@example.com';
  getS3Object.mockClear();
  listS3Objects.mockClear();
  deleteS3Object.mockClear();
  putS3Object.mockClear();
});

describe('storage access is limited to the caller\'s own objects', () => {
  it('refuses an unauthenticated caller on every method', async () => {
    session.email = null;
    expect((await GET(getKey('uploads/desk@example.com/a.csv'))).status).toBe(401);
    expect((await DELETE(del('uploads/desk@example.com/a.csv'))).status).toBe(401);
    expect((await POST(upload('uploads'))).status).toBe(401);
  });

  it('refuses the shared guest account on every method', async () => {
    session.email = TEST_GUEST_EMAIL;
    expect((await GET(getKey(`uploads/${TEST_GUEST_EMAIL}/a.csv`))).status).toBe(401);
    expect((await GET(getPrefix(`uploads/${TEST_GUEST_EMAIL}`))).status).toBe(401);
    expect((await DELETE(del(`uploads/${TEST_GUEST_EMAIL}/a.csv`))).status).toBe(401);
    expect((await POST(upload('uploads'))).status).toBe(401);
    expect(getS3Object).not.toHaveBeenCalled();
    expect(deleteS3Object).not.toHaveBeenCalled();
    expect(putS3Object).not.toHaveBeenCalled();
  });
});

describe('GET /api/storage?key=', () => {
  it('downloads the caller\'s own object', async () => {
    const res = await GET(getKey('market-rates/desk@example.com/rates.csv'));
    expect(res.status).toBe(200);
    expect(getS3Object).toHaveBeenCalledWith('market-rates/desk@example.com/rates.csv');
    expect(await res.text()).toContain('EUR,1.17');
  });

  it('finds the caller\'s objects whatever the case of their sign-in email', async () => {
    session.email = 'Desk@Example.COM';
    const res = await GET(getKey('market-rates/desk@example.com/rates.csv'));
    expect(res.status).toBe(200);
    expect(getS3Object).toHaveBeenCalledTimes(1);
    expect(getS3Object).toHaveBeenCalledWith('market-rates/desk@example.com/rates.csv');
    // The same mixed-case caller still cannot reach another desk's object.
    const other = await GET(getKey('market-rates/other@example.com/rates.csv'));
    expect(other.status).toBe(403);
    expect(getS3Object).toHaveBeenCalledTimes(1);
  });

  it('refuses another desk\'s object', async () => {
    const res = await GET(getKey('market-rates/other@example.com/rates.csv'));
    expect(res.status).toBe(403);
    expect(getS3Object).not.toHaveBeenCalled();
  });

  it('refuses an object under a slug that merely starts with the caller\'s', async () => {
    session.email = 'a@example.com';
    const res = await GET(getKey('uploads/a@example.com.au/rates.csv'));
    expect(res.status).toBe(403);
    expect(getS3Object).not.toHaveBeenCalled();
  });

  it('refuses a key that climbs out of the caller\'s space with ..', async () => {
    const res = await GET(getKey('../uploads/other@example.com/rates.csv'));
    expect(res.status).toBe(403);
    const hidden = await GET(getKey('uploads/..other@example.com/rates.csv'));
    expect(hidden.status).toBe(403);
    expect(getS3Object).not.toHaveBeenCalled();
  });

  it('reads only inside the caller\'s space when a key tries .. after the slug', async () => {
    const res = await GET(getKey('uploads/desk@example.com/../other@example.com/rates.csv'));
    expect(res.status).toBe(200);
    expect(getS3Object).toHaveBeenCalledTimes(1);
    const reached = getS3Object.mock.calls[0]?.[0] ?? '';
    expect(reached.split('/')[1]).toBe('desk@example.com');
    expect(reached).not.toContain('..');
  });

  it('refuses a key that names the caller\'s folder but no file in it', async () => {
    const res = await GET(getKey('uploads/desk@example.com'));
    expect(res.status).toBe(403);
    expect(getS3Object).not.toHaveBeenCalled();
  });

  it('answers 404 for an object that does not exist', async () => {
    getS3Object.mockRejectedValueOnce(noSuchKey());
    const res = await GET(getKey('uploads/desk@example.com/missing.csv'));
    expect(res.status).toBe(404);
  });

  it('does not echo the underlying storage error in a 500', async () => {
    getS3Object.mockRejectedValueOnce(new Error('arn:aws:s3:::internal-bucket AccessDenied'));
    const res = await GET(getKey('uploads/desk@example.com/rates.csv'));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('internal-bucket');
  });
});

describe('GET /api/storage?prefix=', () => {
  it('refuses to list the whole bucket', async () => {
    const res = await GET(getPrefix(''));
    expect(res.status).toBe(403);
    expect(listS3Objects).not.toHaveBeenCalled();
  });

  it('refuses a bare top-level folder, which spans every desk', async () => {
    const res = await GET(getPrefix('uploads'));
    expect(res.status).toBe(403);
    expect(listS3Objects).not.toHaveBeenCalled();
  });

  it('refuses another desk\'s folder', async () => {
    const res = await GET(getPrefix('uploads/other@example.com/'));
    expect(res.status).toBe(403);
    expect(listS3Objects).not.toHaveBeenCalled();
  });

  it('lists the caller\'s own folder with a trailing slash, so a longer slug is not swept in', async () => {
    session.email = 'a@example.com';
    const res = await GET(getPrefix('uploads/a@example.com'));
    expect(res.status).toBe(200);
    expect(listS3Objects).toHaveBeenCalledWith('uploads/a@example.com/', 200);
  });

  it('lists a sub-path of the caller\'s own folder as given', async () => {
    const res = await GET(getPrefix('uploads/desk@example.com/2026-09'));
    expect(res.status).toBe(200);
    expect(listS3Objects).toHaveBeenCalledWith('uploads/desk@example.com/2026-09', 200);
  });

  it('refuses a folder that only reaches the caller\'s slug after an ..', async () => {
    const res = await GET(getPrefix('../desk@example.com'));
    expect(res.status).toBe(403);
    expect(listS3Objects).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/storage', () => {
  it('removes the caller\'s own object', async () => {
    const res = await DELETE(del('market-rates/desk@example.com/rates.csv'));
    expect(res.status).toBe(200);
    expect(deleteS3Object).toHaveBeenCalledWith('market-rates/desk@example.com/rates.csv');
  });

  it('refuses to remove another desk\'s object', async () => {
    const res = await DELETE(del('market-rates/other@example.com/rates.csv'));
    expect(res.status).toBe(403);
    expect(deleteS3Object).not.toHaveBeenCalled();
  });

  it('refuses to remove under a slug that merely starts with the caller\'s', async () => {
    session.email = 'a@example.com';
    const res = await DELETE(del('uploads/a@example.com.au/rates.csv'));
    expect(res.status).toBe(403);
    expect(deleteS3Object).not.toHaveBeenCalled();
  });

  it('refuses a key that climbs out of the caller\'s space with ..', async () => {
    const res = await DELETE(del('../../uploads/other@example.com/rates.csv'));
    expect(res.status).toBe(403);
    expect(deleteS3Object).not.toHaveBeenCalled();
  });

  it('deletes only inside the caller\'s space when a key tries .. after the slug', async () => {
    const res = await DELETE(del('uploads/desk@example.com/../../uploads/other@example.com/rates.csv'));
    expect(res.status).toBe(200);
    const reached = deleteS3Object.mock.calls[0]?.[0] ?? '';
    expect(reached.split('/')[1]).toBe('desk@example.com');
    expect(reached).not.toContain('..');
  });

  it('refuses a key that names the caller\'s folder but no file in it', async () => {
    const res = await DELETE(del('uploads/desk@example.com'));
    expect(res.status).toBe(403);
    expect(deleteS3Object).not.toHaveBeenCalled();
  });

  it('does not echo the underlying storage error in a 500', async () => {
    deleteS3Object.mockRejectedValueOnce(new Error('arn:aws:s3:::internal-bucket AccessDenied'));
    const res = await DELETE(del('uploads/desk@example.com/rates.csv'));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('internal-bucket');
  });
});

describe('folders the app writes itself', () => {
  it('refuses to read or delete the matcher\'s journal object, even the caller\'s own', async () => {
    const key = 'execution-journal/desk@example.com/workspace.json';
    expect((await GET(getKey(key))).status).toBe(403);
    expect((await DELETE(del(key))).status).toBe(403);
    expect(getS3Object).not.toHaveBeenCalled();
    expect(deleteS3Object).not.toHaveBeenCalled();
  });

  it('refuses to list the journal or backup folders', async () => {
    expect((await GET(getPrefix('execution-journal/desk@example.com/'))).status).toBe(403);
    expect((await GET(getPrefix('db_backup/desk@example.com/'))).status).toBe(403);
    expect(listS3Objects).not.toHaveBeenCalled();
  });
});

describe('owners whose emails an underscore slug used to merge', () => {
  it('keeps a+b@ and a_b@ out of each other\'s objects', async () => {
    session.email = 'a+b@example.com';
    expect((await GET(getKey('market-rates/a_b@example.com/rates.csv'))).status).toBe(403);
    expect((await DELETE(del('market-rates/a_b@example.com/rates.csv'))).status).toBe(403);
    expect((await GET(getKey('market-rates/a%2Bb@example.com/rates.csv'))).status).toBe(200);
    expect(getS3Object).toHaveBeenCalledWith('market-rates/a%2Bb@example.com/rates.csv');
  });
});

describe('POST /api/storage', () => {
  it('stores an upload under {folder}/{caller}/', async () => {
    session.email = 'Desk@Example.com';
    const res = await POST(upload('market-rates'));
    expect(res.status).toBe(200);
    const key = putS3Object.mock.calls[0]?.[0].relativeKey ?? '';
    expect(key.startsWith('market-rates/desk@example.com/')).toBe(true);
    expect(key.endsWith('rates.csv')).toBe(true);
  });

  it('defaults the folder to uploads', async () => {
    const res = await POST(upload(null));
    expect(res.status).toBe(200);
    const key = putS3Object.mock.calls[0]?.[0].relativeKey ?? '';
    expect(key.startsWith('uploads/desk@example.com/')).toBe(true);
  });

  it.each([
    ['db_backup', 'a folder the app writes backups into'],
    ['execution-journal', 'the folder the execution journal lives in'],
    ['a/b', 'more than one segment'],
    ['../uploads', 'a parent-directory hop'],
    ['other@example.com', 'a character outside the folder alphabet'],
    ['x'.repeat(65), 'more than 64 characters'],
  ])('rejects folder %j (%s) without writing', async folder => {
    const res = await POST(upload(folder));
    expect(res.status).toBe(400);
    expect(putS3Object).not.toHaveBeenCalled();
  });

  it('does not echo the underlying storage error in a 500', async () => {
    putS3Object.mockRejectedValueOnce(new Error('arn:aws:s3:::internal-bucket AccessDenied'));
    const res = await POST(upload('uploads'));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('internal-bucket');
  });
});
