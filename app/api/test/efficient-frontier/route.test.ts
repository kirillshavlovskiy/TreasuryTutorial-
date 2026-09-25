import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionEmail = { value: 'analyst@example.com' as string | null };
vi.mock('@/auth', () => ({
  auth: async () =>
    sessionEmail.value ? { user: { email: sessionEmail.value } } : null,
  getServerSession: async () =>
    sessionEmail.value ? { user: { email: sessionEmail.value } } : null,
}));

const { POST } = await import('@/app/api/test/efficient-frontier/route');

const body = {
  strategyInput: {
    rows: [],
    months: 12,
    shared: { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 12 },
    activeLayers: ['floorH', 'sigmaP'],
  },
  selectedStrategyId: 'rollingProgramme',
  policyVAR: 5,
  includedCcys: null,
  tabNetByCcyUsd: {},
  carryTargetUsdYr: 0.032,
  scenarioCapUsd: 5,
  bookingMode: 'rolling',
  forecastMonths: 12,
  confidencePct: 95,
};

function post(payload: unknown): Request {
  return new Request('http://localhost/api/test/efficient-frontier', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('POST /api/test/efficient-frontier', () => {
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
    const response = await POST(post({ strategyInput: { rows: [] } }));
    expect(response.status).toBe(400);
    const json = await response.json() as { error?: string };
    expect(json.error).toMatch(/months|shared/);
  });

  it('returns the frontier package for an authenticated analyst', async () => {
    const response = await POST(post(body));
    expect(response.status).toBe(200);
    const json = await response.json() as { results?: unknown[] };
    expect(Array.isArray(json.results)).toBe(true);
    expect(json.results).toHaveLength(0);
  });
});
