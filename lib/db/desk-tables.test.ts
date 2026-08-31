import { describe, expect, it } from 'vitest';
import { deskTableName } from '@/lib/db/storage-env';
import { snapshotsFromSandbox } from '@/lib/desk/sandbox-sync';
import { deskScopeForTask, WORKBENCH_DESK_SCOPE } from '@/lib/desk/types';
import { emptyHedgeBook } from '@/lib/test-mode/hedge-var';
import { emptyAnswers, seedSandbox } from '@/lib/test-mode/store';

describe('desk table names', () => {
  it('partitions UAT vs production', () => {
    expect(deskTableName('workspace', 'uat')).toBe('desk_workspace_uat');
    expect(deskTableName('fx_book', 'production')).toBe('desk_fx_book_production');
    expect(deskTableName('action', 'uat')).toBe('desk_action_uat');
  });

  it('scopes workbench vs curriculum task', () => {
    expect(WORKBENCH_DESK_SCOPE).toBe('workbench');
    expect(deskScopeForTask('01')).toBe('task:01');
    expect(deskScopeForTask('practice')).toBe('task:practice');
  });
});

describe('snapshotsFromSandbox', () => {
  it('writes workspace, liquidity, analytics, and hedge books', () => {
    const state = seedSandbox('01');
    const entity = state.workspace.entities[0]!;
    entity.dashboards = [
      {
        id: 'dash-1',
        name: 'FX',
        createdAt: new Date().toISOString(),
        riskProfiles: [],
      },
    ];
    state.answers = {
      ...emptyAnswers(),
      varConfidencePct: '95',
      varExposureBasis: 'simpleAvg',
      varHorizon: '1y',
    };
    state.hedgesByEntityId = {
      'ent-1': {
        ...emptyHedgeBook(),
        bookedHedges: [
          {
            id: 'h1',
            ccy: 'EUR',
            instrument: 'forward',
            basis: 'simpleAvg',
            amountLocalM: 2,
            maturity: '1y',
            maturityLabel: '1Y',
            varUsdM: 0.1,
            addressesHigherVar: false,
          },
        ],
      },
    };

    const puts = snapshotsFromSandbox(state);
    expect(puts.some(p => p.workspace)).toBe(true);
    expect(puts.some(p => p.hedge?.scopeId && p.hedge.book.bookedHedges.length === 1)).toBe(true);
    expect(puts.some(p => p.analytics?.varSetup?.confidencePct === 95)).toBe(true);
    expect(puts.some(p => p.liquidity?.dashboardId)).toBe(true);
  });
});
