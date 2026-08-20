import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_HEDGE_SCOPE } from '@/lib/test-mode/hedge-var';
import {
  cancelSandboxHydration,
  loadSandboxPersistent,
} from '@/lib/test-mode/sandbox-client';
import { loadSandbox, saveSandbox, seedSandbox } from '@/lib/test-mode/store';

const USER = 'test:hydration-stale';
const TASK = '01';

const preparedEur = {
  structure: 'bullet' as const,
  basis: 'cash' as const,
  ticketBasis: 'stock' as const,
  legs: [],
  coverLocalM: 2,
  hedgeRatio: 0.4,
  preparedFor: 'liquidity' as const,
};

function stubStore() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  });
  vi.stubGlobal('document', {
    addEventListener: () => undefined,
    visibilityState: 'visible',
  });
  return store;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('loadSandboxPersistent stale hydration', () => {
  afterEach(() => {
    cancelSandboxHydration(TASK);
    vi.unstubAllGlobals();
  });

  it('does not let a superseded GET rewrite staged hedges in localStorage', async () => {
    stubStore();
    const booked = {
      ...seedSandbox(TASK),
      hedgesUpdatedAt: '2026-08-01T00:00:00.000Z',
      hedgesByEntityId: {
        [GROUP_HEDGE_SCOPE]: {
          bookedHedges: [],
          hedgeRatios: {},
          preparedByCcy: { EUR: preparedEur },
          desk: { policyVAR: 12, portfolioScenarioId: 'balanced' },
        },
      },
    };
    saveSandbox(USER, booked);

    const getResolvers: Array<(value: ReturnType<typeof jsonResponse>) => void> = [];
    vi.stubGlobal(
      'fetch',
      (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'PUT') {
          return Promise.resolve(
            jsonResponse({
              state: booked,
              updatedAt: '2099-01-01T00:00:00.000Z',
              source: 'database',
              persistent: true,
            }),
          );
        }
        void input;
        return new Promise<ReturnType<typeof jsonResponse>>(resolve => {
          getResolvers.push(resolve);
        });
      },
    );

    const first = loadSandboxPersistent(USER, TASK);
    const second = loadSandboxPersistent(USER, TASK);
    await vi.waitFor(() => expect(getResolvers).toHaveLength(2));

    const emptyRemote = {
      state: {
        ...seedSandbox(TASK),
        hedgesByEntityId: {},
        updatedAt: '2099-01-01T00:00:00.000Z',
      },
      updatedAt: '2099-01-01T00:00:00.000Z',
      source: 'database' as const,
      persistent: true,
    };
    getResolvers[0](jsonResponse(emptyRemote));
    await first;

    expect(
      loadSandbox(USER).hedgesByEntityId?.[GROUP_HEDGE_SCOPE]?.preparedByCcy?.EUR
        ?.preparedFor,
    ).toBe('liquidity');
    expect(
      loadSandbox(USER).hedgesByEntityId?.[GROUP_HEDGE_SCOPE]?.desk?.policyVAR,
    ).toBe(12);

    getResolvers[1](jsonResponse(emptyRemote));
    const live = await second;
    expect(
      live.state.hedgesByEntityId?.[GROUP_HEDGE_SCOPE]?.preparedByCcy?.EUR
        ?.preparedFor,
    ).toBe('liquidity');
    expect(
      loadSandbox(USER).hedgesByEntityId?.[GROUP_HEDGE_SCOPE]?.preparedByCcy?.EUR
        ?.preparedFor,
    ).toBe('liquidity');
  });

  it('does not let hydration overwrite a package booked while GET is in flight', async () => {
    stubStore();
    saveSandbox(USER, seedSandbox(TASK));

    const getResolvers: Array<(value: ReturnType<typeof jsonResponse>) => void> = [];
    vi.stubGlobal(
      'fetch',
      (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'PUT') {
          return Promise.resolve(
            jsonResponse({
              updatedAt: '2099-01-01T00:00:00.000Z',
              source: 'database',
              persistent: true,
            }),
          );
        }
        void input;
        return new Promise<ReturnType<typeof jsonResponse>>(resolve => {
          getResolvers.push(resolve);
        });
      },
    );

    const pending = loadSandboxPersistent(USER, TASK);
    await vi.waitFor(() => expect(getResolvers).toHaveLength(1));

    saveSandbox(USER, {
      ...loadSandbox(USER),
      hedgesUpdatedAt: '2026-08-19T12:00:00.000Z',
      hedgesByEntityId: {
        [GROUP_HEDGE_SCOPE]: {
          bookedHedges: [],
          hedgeRatios: {},
          preparedByCcy: { EUR: preparedEur },
          desk: {
            policyVAR: 12,
            portfolioScenarioId: 'balanced',
            activeLayers: ['carryOptim'],
          },
        },
      },
    });

    getResolvers[0](
      jsonResponse({
        state: {
          ...seedSandbox(TASK),
          hedgesByEntityId: {},
          updatedAt: '2099-01-01T00:00:00.000Z',
        },
        updatedAt: '2099-01-01T00:00:00.000Z',
        source: 'database' as const,
        persistent: true,
      }),
    );

    const live = await pending;
    expect(
      live.state.hedgesByEntityId?.[GROUP_HEDGE_SCOPE]?.preparedByCcy?.EUR
        ?.preparedFor,
    ).toBe('liquidity');
    expect(
      live.state.hedgesByEntityId?.[GROUP_HEDGE_SCOPE]?.desk?.portfolioScenarioId,
    ).toBe('balanced');
    expect(
      loadSandbox(USER).hedgesByEntityId?.[GROUP_HEDGE_SCOPE]?.preparedByCcy?.EUR
        ?.preparedFor,
    ).toBe('liquidity');
  });
});
