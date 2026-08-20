import { describe, expect, it } from 'vitest';
import {
  applyDeskPatch,
  fillMarketRatesFromExisting,
  hedgeBookContentScore,
  hedgeLedgerChanged,
  mergeHedgesWithSidecar,
  normalizeHedgeBooksMap,
  parseHedgeSidecar,
  pickHedgeBooksForWrite,
  rebindHedgeBooksToWorkspace,
  serializeHedgeSidecar,
} from '@/lib/hedge-book-normalize';
import { GROUP_HEDGE_SCOPE } from '@/lib/test-mode/hedge-var';
import { NORDTECH_ENTITY_IDS } from '@/lib/test-mode/fixtures/nordtech-accounts';

describe('normalizeHedgeBooksMap', () => {
  it('drops non-objects and fills missing book fields', () => {
    const out = normalizeHedgeBooksMap({
      skip: 'nope',
      ent: { bookedHedges: [{ id: 't1' }], hedgeRatios: { EUR: 1 } },
    });
    expect(out.skip).toBeUndefined();
    expect(out.ent?.bookedHedges).toHaveLength(1);
    expect(out.ent?.hedgeRatios).toEqual({ EUR: 1 });
    expect(out.ent?.preparedByCcy).toEqual({});
    expect(out.ent?.marketRatesByCcy).toEqual({});
  });
});

describe('pickHedgeBooksForWrite', () => {
  const prepared = {
    EUR: {
      structure: 'bullet' as const,
      basis: 'cash' as const,
      ticketBasis: 'stock' as const,
      legs: [],
      coverLocalM: 1,
      hedgeRatio: 0.5,
      preparedFor: 'liquidity' as const,
    },
  };

  it('merges when a same-clock PUT drops prepared packages', () => {
    const existing = {
      ent: {
        bookedHedges: [{ id: 't1' }] as never,
        hedgeRatios: {},
        preparedByCcy: prepared,
      },
    };
    const incoming = {
      ent: {
        bookedHedges: [{ id: 't1' }] as never,
        hedgeRatios: {},
        preparedByCcy: {},
      },
    };
    const picked = pickHedgeBooksForWrite(
      incoming,
      existing,
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    expect(picked.hedgesByEntityId.ent?.preparedByCcy?.EUR?.preparedFor).toBe(
      'liquidity',
    );
  });

  it('does not let a newer hedge clock un-prepare when tickets are kept', () => {
    const existing = {
      ent: {
        bookedHedges: [{ id: 't1' }] as never,
        hedgeRatios: {},
        preparedByCcy: prepared,
      },
    };
    const incoming = {
      ent: {
        bookedHedges: [{ id: 't1' }] as never,
        hedgeRatios: {},
        preparedByCcy: {},
      },
    };
    const picked = pickHedgeBooksForWrite(
      incoming,
      existing,
      '2026-07-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    expect(picked.hedgesByEntityId.ent?.preparedByCcy?.EUR?.preparedFor).toBe(
      'liquidity',
    );
  });

  it('does not let a newer clock drop staged packages that were never booked', () => {
    const existing = {
      ent: {
        bookedHedges: [] as never[],
        hedgeRatios: {},
        preparedByCcy: prepared,
      },
    };
    const incoming = {
      ent: {
        bookedHedges: [] as never[],
        hedgeRatios: {},
        preparedByCcy: {},
      },
    };
    const picked = pickHedgeBooksForWrite(
      incoming,
      existing,
      '2026-07-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    expect(picked.hedgesByEntityId.ent?.preparedByCcy?.EUR?.preparedFor).toBe(
      'liquidity',
    );
  });

  it('lets a newer hedge clock un-stage one of several packages', () => {
    const existing = {
      ent: {
        bookedHedges: [{ id: 't1' }] as never,
        hedgeRatios: {},
        preparedByCcy: {
          EUR: prepared.EUR,
          JPY: { ...prepared.EUR },
        },
      },
    };
    const incoming = {
      ent: {
        bookedHedges: [{ id: 't1' }] as never,
        hedgeRatios: {},
        preparedByCcy: { EUR: prepared.EUR },
      },
    };
    const picked = pickHedgeBooksForWrite(
      incoming,
      existing,
      '2026-07-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    expect(Object.keys(picked.hedgesByEntityId.ent?.preparedByCcy ?? {})).toEqual(
      ['EUR'],
    );
  });

  it('does not let a newer empty shell wipe tickets and packages', () => {
    const existing = {
      ent: {
        bookedHedges: [{ id: 't1' }] as never,
        hedgeRatios: {},
        preparedByCcy: prepared,
        desk: { policyVAR: 12, residualByCcy: { EUR: 0.4 } },
      },
    };
    const incoming = {
      ent: {
        bookedHedges: [],
        hedgeRatios: {},
        preparedByCcy: {},
        desk: { policyVAR: 5 },
      },
    };
    const picked = pickHedgeBooksForWrite(
      incoming,
      existing,
      '2026-07-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    expect(picked.hedgesByEntityId.ent?.bookedHedges.map(t => t.id)).toEqual(['t1']);
    expect(picked.hedgesByEntityId.ent?.preparedByCcy?.EUR?.preparedFor).toBe(
      'liquidity',
    );
    expect(picked.hedgesByEntityId.ent?.desk?.residualByCcy?.EUR).toBe(0.4);
    expect(picked.hedgesByEntityId.ent?.desk?.policyVAR).toBe(12);
  });

  it('does not let a Fast Refresh default desk wipe overlay layers and the sweet chip', () => {
    const existing = {
      ent: {
        bookedHedges: [] as never[],
        hedgeRatios: {},
        preparedByCcy: prepared,
        desk: {
          policyVAR: 12,
          residualByCcy: { EUR: 0.4 },
          activeLayers: ['carryOptim', 'portfolioDiv'],
          portfolioScenarioId: 'balanced',
        },
      },
    };
    const incoming = {
      ent: {
        bookedHedges: [] as never[],
        hedgeRatios: {},
        preparedByCcy: prepared,
        desk: {
          policyVAR: 5,
          residualByCcy: { EUR: 0.4 },
          activeLayers: [],
          portfolioScenarioId: '',
        },
      },
    };
    const picked = pickHedgeBooksForWrite(
      incoming,
      existing,
      '2026-07-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    expect(picked.hedgesByEntityId.ent?.desk?.policyVAR).toBe(12);
    expect(picked.hedgesByEntityId.ent?.desk?.activeLayers).toEqual([
      'carryOptim',
      'portfolioDiv',
    ]);
    expect(picked.hedgesByEntityId.ent?.desk?.portfolioScenarioId).toBe(
      'balanced',
    );
    expect(picked.hedgesByEntityId.ent?.preparedByCcy?.EUR?.preparedFor).toBe(
      'liquidity',
    );
  });

  it('keeps existing entities when a newer PUT omits them', () => {
    const existing = {
      ent: {
        bookedHedges: [{ id: 't1' }] as never,
        hedgeRatios: {},
        preparedByCcy: prepared,
      },
    };
    const picked = pickHedgeBooksForWrite(
      {},
      existing,
      '2026-07-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    expect(picked.hedgesByEntityId.ent?.preparedByCcy?.EUR?.preparedFor).toBe(
      'liquidity',
    );
  });
});

describe('hedgeBookContentScore', () => {
  it('counts booked tickets and prepared packages', () => {
    const score = hedgeBookContentScore({
      a: {
        bookedHedges: [{ id: '1' }, { id: '2' }] as never,
        hedgeRatios: {},
        preparedByCcy: { EUR: {} as never, JPY: {} as never },
      },
      b: { bookedHedges: [], hedgeRatios: {}, preparedByCcy: {} },
    });
    expect(score).toEqual({
      booked: 2,
      prepared: 2,
      desk: 0,
      carry: 0,
      market: 0,
    });
  });

  it('counts desk overlay sliders', () => {
    const score = hedgeBookContentScore({
      a: {
        bookedHedges: [],
        hedgeRatios: {},
        desk: { residualByCcy: { EUR: 0.4, JPY: 0.2 }, policyVAR: 8 },
      },
    });
    expect(score).toEqual({
      booked: 0,
      prepared: 0,
      desk: 3,
      carry: 0,
      market: 0,
    });
  });
});

describe('hedgeLedgerChanged', () => {
  it('treats overlay / Policy VAR / sweet-spot chip as a ledger write', () => {
    const empty = {
      ent: { bookedHedges: [], hedgeRatios: {}, preparedByCcy: {} },
    };
    const withDesk = {
      ent: {
        bookedHedges: [],
        hedgeRatios: {},
        preparedByCcy: {},
        desk: { policyVAR: 12, portfolioScenarioId: 'balanced' },
      },
    };
    expect(hedgeLedgerChanged(empty, withDesk)).toBe(true);
    expect(hedgeLedgerChanged(withDesk, withDesk)).toBe(false);
  });
});

describe('applyDeskPatch', () => {
  it('merges a partial overlay into the existing desk', () => {
    const patched = applyDeskPatch(
      {
        bookedHedges: [],
        hedgeRatios: {},
        preparedByCcy: {
          EUR: {
            structure: 'bullet',
            basis: 'cash',
            ticketBasis: 'stock',
            legs: [],
            coverLocalM: 1,
            hedgeRatio: 0.5,
            preparedFor: 'liquidity',
          },
        },
        desk: { residualByCcy: { EUR: 0.9 }, policyVAR: 8 },
      },
      { residualByCcy: { EUR: 0.2 } },
    );
    expect(patched.preparedByCcy?.EUR?.preparedFor).toBe('liquidity');
    expect(patched.desk?.residualByCcy).toEqual({ EUR: 0.2 });
    expect(patched.desk?.policyVAR).toBe(8);
  });
});

describe('hedge sidecar', () => {
  it('round-trips prepared packages and restores them over an empty primary book', () => {
    const hedges = {
      ent: {
        bookedHedges: [],
        hedgeRatios: {},
        preparedByCcy: {
          EUR: {
            structure: 'bullet' as const,
            basis: 'cash' as const,
            ticketBasis: 'stock' as const,
            legs: [],
            coverLocalM: 1,
            hedgeRatio: 0.5,
            preparedFor: 'liquidity' as const,
          },
        },
      },
    };
    const sidecar = parseHedgeSidecar(
      serializeHedgeSidecar(hedges, '2026-06-01T00:00:00.000Z'),
    );
    expect(sidecar?.hedgesByEntityId.ent?.preparedByCcy?.EUR?.preparedFor).toBe(
      'liquidity',
    );
    const merged = mergeHedgesWithSidecar({}, undefined, sidecar);
    expect(merged.hedgesByEntityId.ent?.preparedByCcy?.EUR?.preparedFor).toBe(
      'liquidity',
    );
  });
});

describe('rebindHedgeBooksToWorkspace', () => {
  const entities = [
    { id: NORDTECH_ENTITY_IDS.us, name: 'NordTech US' },
    { id: NORDTECH_ENTITY_IDS.de, name: 'NordTech GmbH' },
    { id: NORDTECH_ENTITY_IDS.pl, name: 'NordTech Poland' },
  ];
  const prepared = {
    EUR: {
      structure: 'bullet' as const,
      basis: 'cash' as const,
      ticketBasis: 'stock' as const,
      legs: [],
      coverLocalM: 1,
      hedgeRatio: 0.5,
      preparedFor: 'liquidity' as const,
    },
  };

  it('moves a rotated entity book onto the live id by ticket name', () => {
    const rebound = rebindHedgeBooksToWorkspace(
      {
        ent_msgjt8gb_dilnfg: {
          bookedHedges: [
            {
              id: 't1',
              ccy: 'EUR',
              instrument: 'forward',
              basis: 'stock',
              amountLocalM: 1,
              maturity: '1m',
              maturityLabel: '1m',
              varUsdM: 0.1,
              addressesHigherVar: false,
              entityName: 'NordTech GmbH',
            },
          ],
          hedgeRatios: {},
          preparedByCcy: prepared,
        },
      },
      entities,
    );
    expect(
      rebound[NORDTECH_ENTITY_IDS.de]?.preparedByCcy?.EUR?.preparedFor,
    ).toBe('liquidity');
    expect(rebound.ent_msgjt8gb_dilnfg).toBeUndefined();
  });

  it('attaches a single rotated prepared book to the preferred live entity', () => {
    const rebound = rebindHedgeBooksToWorkspace(
      {
        ent_mrv22d5d_dzem3s: {
          bookedHedges: [],
          hedgeRatios: {},
          preparedByCcy: prepared,
        },
      },
      entities,
      NORDTECH_ENTITY_IDS.de,
    );
    expect(
      rebound[NORDTECH_ENTITY_IDS.de]?.preparedByCcy?.EUR?.preparedFor,
    ).toBe('liquidity');
    expect(rebound.ent_mrv22d5d_dzem3s).toBeUndefined();
  });

  it('keeps group-scope packages and drops empty orphan shells', () => {
    const rebound = rebindHedgeBooksToWorkspace(
      {
        [GROUP_HEDGE_SCOPE]: {
          bookedHedges: [],
          hedgeRatios: {},
          preparedByCcy: prepared,
        },
        ent_mrv0w3ly_19og9r: {
          bookedHedges: [],
          hedgeRatios: {},
          preparedByCcy: {},
        },
      },
      entities,
    );
    expect(rebound[GROUP_HEDGE_SCOPE]?.preparedByCcy?.EUR?.preparedFor).toBe(
      'liquidity',
    );
    expect(rebound.ent_mrv0w3ly_19og9r).toBeUndefined();
  });
});

describe('fillMarketRatesFromExisting', () => {
  it('copies curves onto a ledger-only patch', () => {
    const existing = {
      ent: {
        bookedHedges: [],
        hedgeRatios: {},
        preparedByCcy: {},
        marketRatesByCcy: {
          EUR: { pair: 'EURUSD', baseCcy: 'EUR', quoteCcy: 'USD', sourceFile: 'x', deposits: [] },
        },
      },
    };
    const incoming = {
      ent: {
        bookedHedges: [],
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
        marketRatesByCcy: {},
      },
    };
    const filled = fillMarketRatesFromExisting(incoming, existing);
    expect(filled.ent?.marketRatesByCcy?.EUR?.pair).toBe('EURUSD');
    expect(filled.ent?.preparedByCcy?.EUR?.preparedFor).toBe('liquidity');
  });
});
