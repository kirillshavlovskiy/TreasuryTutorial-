import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionEmail = { value: 'analyst@example.com' as string | null };
vi.mock('@/auth', () => ({
  auth: async () =>
    sessionEmail.value ? { user: { email: sessionEmail.value } } : null,
  getServerSession: async () =>
    sessionEmail.value ? { user: { email: sessionEmail.value } } : null,
}));

const { POST } = await import('@/app/api/test/quant-fx-sigma/route');

const body = {
  rows: [],
  forecastMonths: 12,
  confidencePct: 95,
  rUsd: 4,
};

function post(payload: unknown): Request {
  return new Request('http://localhost/api/test/quant-fx-sigma', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('POST /api/test/quant-fx-sigma', () => {
  beforeEach(() => {
    sessionEmail.value = 'analyst@example.com';
  });

  it('refuses anonymous and guest callers', async () => {
    sessionEmail.value = null;
    expect((await POST(post(body))).status).toBe(401);
    sessionEmail.value = 'test@sigma.local';
    expect((await POST(post(body))).status).toBe(401);
  });

  it('answers 400 with the reason on a bad body', async () => {
    const response = await POST(post({ forecastMonths: 12 }));
    expect(response.status).toBe(400);
    const json = await response.json() as { error?: string };
    expect(json.error).toMatch(/rows/);
  });

  it('returns the Optimize package for an authenticated analyst', async () => {
    const response = await POST(post(body));
    expect(response.status).toBe(200);
    const json = await response.json() as { curve?: unknown[]; legs?: unknown[] };
    expect(Array.isArray(json.curve)).toBe(true);
    expect(Array.isArray(json.legs)).toBe(true);
  });
});
