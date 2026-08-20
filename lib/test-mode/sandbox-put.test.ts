import { describe, expect, it } from 'vitest';
import { NORDTECH_ENTITY_IDS } from '@/lib/test-mode/fixtures/nordtech-accounts';
import {
  applySandboxPutPayload,
  canUseKeepaliveFetch,
  SANDBOX_KEEPALIVE_MAX_BYTES,
} from '@/lib/test-mode/sandbox-put';
import { seedNordtechWorkspace, seedSandbox } from '@/lib/test-mode/store';

describe('NordTech seed ids', () => {
  it('uses stable entity ids so a reseed cannot orphan the hedge book', () => {
    const a = seedNordtechWorkspace();
    const b = seedNordtechWorkspace();
    expect(a.entities.map(e => e.id)).toEqual([
      NORDTECH_ENTITY_IDS.us,
      NORDTECH_ENTITY_IDS.de,
      NORDTECH_ENTITY_IDS.pl,
    ]);
    expect(b.entities.map(e => e.id)).toEqual(a.entities.map(e => e.id));
  });
});

describe('sandbox PUT keepalive', () => {
  it('rejects bodies over the Chromium keepalive quota', () => {
    expect(canUseKeepaliveFetch('{"ok":true}')).toBe(true);
    expect(canUseKeepaliveFetch('x'.repeat(SANDBOX_KEEPALIVE_MAX_BYTES + 1))).toBe(
      false,
    );
  });
});

describe('applySandboxPutPayload', () => {
  it('merges a hedge patch onto the existing row without dropping market curves', () => {
    const existing = {
      ...seedSandbox('01'),
      hedgesByEntityId: {
        [NORDTECH_ENTITY_IDS.de]: {
          bookedHedges: [],
          hedgeRatios: {},
          preparedByCcy: {},
          marketRatesByCcy: {
            EUR: {
              pair: 'EURUSD',
              baseCcy: 'EUR',
              quoteCcy: 'USD',
              sourceFile: 'x',
              deposits: [],
            },
          },
        },
      },
    };
    const next = applySandboxPutPayload(
      {
        taskId: '01',
        patch: 'hedges',
        hedgesByEntityId: {
          [NORDTECH_ENTITY_IDS.de]: {
            bookedHedges: [],
            hedgeRatios: {},
            preparedByCcy: {
              EUR: {
                structure: 'bullet',
                basis: 'cash',
                ticketBasis: 'stock',
                legs: [],
                coverLocalM: 2,
                hedgeRatio: 1,
                preparedFor: 'liquidity',
              },
            },
            marketRatesByCcy: {},
          },
        },
        hedgesUpdatedAt: '2026-08-19T18:00:00.000Z',
      },
      existing,
      '01',
    );
    const book = next.hedgesByEntityId[NORDTECH_ENTITY_IDS.de];
    expect(book?.preparedByCcy?.EUR?.coverLocalM).toBe(2);
    expect(book?.marketRatesByCcy?.EUR?.pair).toBe('EURUSD');
  });
});
