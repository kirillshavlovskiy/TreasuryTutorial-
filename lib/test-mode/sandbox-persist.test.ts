import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mergeHedgeDesk,
  normalizeHedgeDesk,
} from '@/lib/hedge-book-normalize';
import { residualByCcyFromBook } from '@/lib/test-mode/hedge-var';
import { NORDTECH_ENTITY_IDS } from '@/lib/test-mode/fixtures/nordtech-accounts';
import {
  loadSandbox,
  saveSandbox,
  sandboxStateWithProtectedHedges,
  seedSandbox,
} from '@/lib/test-mode/store';
import type { EntityHedgeBook, HedgeTicket } from '@/lib/test-mode/hedge-var';

const ticket = (id: string): HedgeTicket => ({
  id,
  ccy: 'EUR',
  instrument: 'forward',
  basis: 'stock',
  amountLocalM: 1,
  maturity: '1m',
  maturityLabel: '1m',
  varUsdM: 0.1,
  addressesHigherVar: false,
});

function bookWithTickets(...ids: string[]): EntityHedgeBook {
  return {
    bookedHedges: ids.map(ticket),
    hedgeRatios: {},
    preparedByCcy: {},
  };
}

describe('normalizeHedgeDesk', () => {
  it('keeps finite overlay fields and drops junk', () => {
    const desk = normalizeHedgeDesk({
      residualByCcy: { EUR: 0.35, BAD: 'nope' },
      policyVAR: 12,
      hedgeStrategy: 'SWAP_FWD',
      extra: 1,
    });
    expect(desk?.residualByCcy).toEqual({ EUR: 0.35 });
    expect(desk?.policyVAR).toBe(12);
    expect(desk?.hedgeStrategy).toBe('SWAP_FWD');
  });

  it('keeps swap-forward overlay notionals', () => {
    const desk = normalizeHedgeDesk({
      swapForwardOverlayByCcy: {
        EUR: {
          delta: 0.4,
          exposureLocalM: 10,
          swapNearLocalM: 2,
          swapStandingLocalM: 2,
          forwardLocalM: -10.8,
          remainingFarLocalM: -1.2,
          residualNearLocalM: 1.2,
          finalNetLocalM: 0,
        },
      },
    });
    expect(desk?.swapForwardOverlayByCcy?.EUR?.delta).toBe(0.4);
    expect(desk?.swapForwardOverlayByCcy?.EUR?.forwardLocalM).toBe(-10.8);
  });

  it('keeps buffer chips and the overlay sweet-spot chip', () => {
    const desk = normalizeHedgeDesk({
      activeLayers: ['carryOptim', 'portfolioDiv', 'nope'],
      portfolioScenarioId: 'balanced',
    });
    expect(desk?.activeLayers).toEqual(['carryOptim', 'portfolioDiv']);
    expect(desk?.portfolioScenarioId).toBe('balanced');
  });
});

describe('mergeHedgeDesk', () => {
  it('lets the newer overlay win per CCY and fills gaps', () => {
    const merged = mergeHedgeDesk(
      { residualByCcy: { EUR: 0.2 }, policyVAR: 7, activeLayers: ['carryOptim'] },
      { residualByCcy: { EUR: 0.9, JPY: 0.1 }, portfolioCarryK: 15, portfolioScenarioId: 'balanced' },
    );
    expect(merged?.residualByCcy).toEqual({ EUR: 0.2, JPY: 0.1 });
    expect(merged?.policyVAR).toBe(7);
    expect(merged?.portfolioCarryK).toBe(15);
    expect(merged?.activeLayers).toEqual(['carryOptim']);
    expect(merged?.portfolioScenarioId).toBe('balanced');
  });
});

describe('residualByCcyFromBook', () => {
  it('uses staged liquidity hedgeRatio then desk overlay', () => {
    const residual = residualByCcyFromBook({
      preparedByCcy: {
        EUR: {
          structure: 'strip',
          basis: 'cash',
          ticketBasis: 'stock',
          legs: [],
          coverLocalM: 2,
          hedgeRatio: 0.4,
          preparedFor: 'liquidity',
        },
      },
      desk: { residualByCcy: { EUR: 0.55, JPY: 0.1 } },
    });
    expect(residual).toEqual({ EUR: 0.55, JPY: 0.1 });
  });
});

describe('sandboxStateWithProtectedHedges', () => {
  it('does not let a newer empty PUT wipe booked tickets', () => {
    const existing = {
      ...seedSandbox('01'),
      updatedAt: '2026-01-01T00:00:00.000Z',
      hedgesByEntityId: { ent_1: bookWithTickets('keep-me') },
    };
    const incoming = {
      ...seedSandbox('01'),
      updatedAt: '2026-06-01T00:00:00.000Z',
      hedgesByEntityId: {},
    };
    const protectedState = sandboxStateWithProtectedHedges(incoming, existing);
    expect(protectedState.hedgesByEntityId.ent_1?.bookedHedges.map(t => t.id)).toEqual([
      'keep-me',
    ]);
  });

  it('does not let a newer empty map with a newer hedge clock wipe tickets', () => {
    const existing = {
      ...seedSandbox('01'),
      updatedAt: '2026-01-01T00:00:00.000Z',
      hedgesUpdatedAt: '2026-01-01T00:00:00.000Z',
      hedgesByEntityId: { ent_1: bookWithTickets('keep-me') },
    };
    const incoming = {
      ...seedSandbox('01'),
      updatedAt: '2026-06-01T00:00:00.000Z',
      hedgesUpdatedAt: '2026-06-01T00:00:00.000Z',
      hedgesByEntityId: {},
    };
    const protectedState = sandboxStateWithProtectedHedges(incoming, existing);
    expect(protectedState.hedgesByEntityId.ent_1?.bookedHedges.map(t => t.id)).toEqual([
      'keep-me',
    ]);
  });

  it('does not let a newer empty entity shell wipe prepared packages', () => {
    const existing = {
      ...seedSandbox('01'),
      updatedAt: '2026-01-01T00:00:00.000Z',
      hedgesUpdatedAt: '2026-01-01T00:00:00.000Z',
      hedgesByEntityId: {
        ent_1: {
          bookedHedges: [ticket('keep-me')],
          hedgeRatios: {},
          preparedByCcy: {
            EUR: {
              structure: 'bullet',
              basis: 'cash',
              ticketBasis: 'stock',
              legs: [],
              coverLocalM: 1,
              hedgeRatio: 1,
              preparedFor: 'liquidity',
            },
          },
        },
      },
    };
    const incoming = {
      ...seedSandbox('01'),
      updatedAt: '2026-06-01T00:00:00.000Z',
      hedgesUpdatedAt: '2026-06-01T00:00:00.000Z',
      hedgesByEntityId: {
        ent_1: {
          bookedHedges: [],
          hedgeRatios: {},
          preparedByCcy: {},
          desk: { policyVAR: 5 },
        },
      },
    };
    const protectedState = sandboxStateWithProtectedHedges(incoming, existing);
    expect(
      protectedState.hedgesByEntityId.ent_1?.preparedByCcy?.EUR?.preparedFor,
    ).toBe('liquidity');
    expect(protectedState.hedgesByEntityId.ent_1?.bookedHedges.map(t => t.id)).toEqual([
      'keep-me',
    ]);
  });

  it('does not let a newer booked snapshot drop prepared packages', () => {
    const existing = {
      ...seedSandbox('01'),
      updatedAt: '2026-01-01T00:00:00.000Z',
      hedgesUpdatedAt: '2026-01-01T00:00:00.000Z',
      hedgesByEntityId: {
        ent_1: {
          bookedHedges: [ticket('keep-me')],
          hedgeRatios: {},
          preparedByCcy: {
            EUR: {
              structure: 'bullet',
              basis: 'cash',
              ticketBasis: 'stock',
              legs: [],
              coverLocalM: 1,
              hedgeRatio: 1,
              preparedFor: 'liquidity',
            },
          },
        },
      },
    };
    const incoming = {
      ...seedSandbox('01'),
      updatedAt: '2026-06-01T00:00:00.000Z',
      hedgesUpdatedAt: '2026-01-01T00:00:00.000Z',
      hedgesByEntityId: { ent_1: bookWithTickets('keep-me') },
    };
    const protectedState = sandboxStateWithProtectedHedges(incoming, existing);
    expect(
      protectedState.hedgesByEntityId.ent_1?.preparedByCcy?.EUR?.preparedFor,
    ).toBe('liquidity');
  });

  it('does not let a newer hedge clock replace prepared packages', () => {
    const existing = {
      ...seedSandbox('01'),
      updatedAt: '2026-01-01T00:00:00.000Z',
      hedgesUpdatedAt: '2026-01-01T00:00:00.000Z',
      hedgesByEntityId: {
        ent_1: {
          bookedHedges: [ticket('keep-me')],
          hedgeRatios: {},
          preparedByCcy: {
            EUR: {
              structure: 'bullet',
              basis: 'cash',
              ticketBasis: 'stock',
              legs: [],
              coverLocalM: 1,
              hedgeRatio: 1,
              preparedFor: 'liquidity',
            },
          },
        },
      },
    };
    const incoming = {
      ...seedSandbox('01'),
      updatedAt: '2026-06-01T00:00:00.000Z',
      hedgesUpdatedAt: '2026-06-01T00:00:00.000Z',
      hedgesByEntityId: { ent_1: bookWithTickets('keep-me') },
    };
    const protectedState = sandboxStateWithProtectedHedges(incoming, existing);
    expect(
      protectedState.hedgesByEntityId.ent_1?.preparedByCcy?.EUR?.preparedFor,
    ).toBe('liquidity');
  });

  it('keeps the existing row when the PUT is stale', () => {
    const existing = {
      ...seedSandbox('01'),
      updatedAt: '2026-06-01T00:00:00.000Z',
      hedgesByEntityId: { ent_1: bookWithTickets('server') },
    };
    const incoming = {
      ...seedSandbox('01'),
      updatedAt: '2026-01-01T00:00:00.000Z',
      hedgesByEntityId: { ent_1: bookWithTickets('stale') },
    };
    const protectedState = sandboxStateWithProtectedHedges(incoming, existing);
    const ids = protectedState.hedgesByEntityId.ent_1?.bookedHedges.map(t => t.id) ?? [];
    expect(ids).toContain('server');
    expect(ids).toContain('stale');
  });
});

describe('sandbox hedge sidecar', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubLocalStorage() {
    const store = new Map<string, string>();
    const localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    };
    const previous = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { localStorage },
    });
    return {
      store,
      restore: () => {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          writable: true,
          value: previous,
        });
      },
    };
  }

  it('restores prepared packages when the main sandbox blob is missing', () => {
    const { store, restore } = stubLocalStorage();
    try {
      const state = {
        ...seedSandbox('01'),
        hedgesUpdatedAt: '2026-06-01T00:00:00.000Z',
        hedgesByEntityId: {
          [NORDTECH_ENTITY_IDS.de]: {
            bookedHedges: [ticket('keep-me')],
            hedgeRatios: {},
            preparedByCcy: {
              EUR: {
                structure: 'bullet' as const,
                basis: 'cash' as const,
                ticketBasis: 'stock' as const,
                legs: [],
                coverLocalM: 1,
                hedgeRatio: 1,
                preparedFor: 'liquidity' as const,
              },
            },
          },
        },
      };
      saveSandbox('test:analyst@sigma.local', state);
      for (const key of [...store.keys()]) {
        if (!key.endsWith('::hedges')) store.delete(key);
      }
      const loaded = loadSandbox('test:analyst@sigma.local');
      expect(
        loaded.hedgesByEntityId[NORDTECH_ENTITY_IDS.de]?.bookedHedges[0]?.id,
      ).toBe('keep-me');
      expect(
        loaded.hedgesByEntityId[NORDTECH_ENTITY_IDS.de]?.preparedByCcy?.EUR
          ?.preparedFor,
      ).toBe('liquidity');
    } finally {
      restore();
    }
  });

  it('does not let a thinner save overwrite prepared packages already on disk', () => {
    const { restore } = stubLocalStorage();
    try {
      const user = 'test:analyst@sigma.local';
      const rich = {
        ...seedSandbox('01'),
        hedgesUpdatedAt: '2026-06-01T00:00:00.000Z',
        hedgesByEntityId: {
          [NORDTECH_ENTITY_IDS.de]: {
            bookedHedges: [ticket('keep-me')],
            hedgeRatios: {},
            preparedByCcy: {
              EUR: {
                structure: 'bullet' as const,
                basis: 'cash' as const,
                ticketBasis: 'stock' as const,
                legs: [],
                coverLocalM: 1,
                hedgeRatio: 1,
                preparedFor: 'liquidity' as const,
              },
            },
            desk: {
              policyVAR: 12,
              portfolioScenarioId: 'balanced',
              activeLayers: ['carryOptim' as const],
            },
          },
        },
      };
      saveSandbox(user, rich);
      saveSandbox(user, {
        ...seedSandbox('01'),
        hedgesUpdatedAt: '2026-08-01T00:00:00.000Z',
        hedgesByEntityId: {
          [NORDTECH_ENTITY_IDS.de]: {
            bookedHedges: [ticket('keep-me')],
            hedgeRatios: {},
            preparedByCcy: {},
            desk: { policyVAR: 5, activeLayers: [] },
          },
        },
      });
      const loaded = loadSandbox(user);
      expect(
        loaded.hedgesByEntityId[NORDTECH_ENTITY_IDS.de]?.preparedByCcy?.EUR
          ?.preparedFor,
      ).toBe('liquidity');
      expect(
        loaded.hedgesByEntityId[NORDTECH_ENTITY_IDS.de]?.desk?.portfolioScenarioId,
      ).toBe('balanced');
      expect(
        loaded.hedgesByEntityId[NORDTECH_ENTITY_IDS.de]?.desk?.policyVAR,
      ).toBe(12);
    } finally {
      restore();
    }
  });
});
