import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyStructureWizard,
  createDashboardFromWizard,
  createEntity,
  createRateInstrument,
  dashboardSetupFromDashboard,
  defaultCurriculumFxConfig,
  defaultRateIndex,
  emptyWorkspace,
  fxConfigFromDashboardSetup,
  groupFxUnlocked,
  saveWorkspace,
  supportsInstruments,
  tickersFromInstruments,
  updateDashboardFromWizard,
  type DashboardSetup,
  type Workspace,
} from '@/lib/workspace-store';
import {
  applyWorkbenchStructureToSandbox,
  workspaceGroupToSandboxGroup,
} from '@/lib/workspace-curriculum-bridge';
import { seedSandbox } from '@/lib/test-mode/store';

describe('applyStructureWizard', () => {
  const fxDesk: DashboardSetup = {
    riskAsset: 'currencies',
    protect: ['assetValue', 'cashFlow'],
    optimize: ['var', 'hedgeCarry'],
    tickers: ['EUR', 'GBP', 'JPY'],
  };

  it('creates parent group, subsidiaries, dashboards, and FX profiles', () => {
    const next = applyStructureWizard(emptyWorkspace(), {
      groupName: 'NordTech Holdings',
      reportingCurrency: 'USD',
      groupDashboardName: 'Group FX (consolidated)',
      subsidiaries: [
        { name: 'NordTech US', baseCurrency: 'USD', dashboardName: 'US FX', setup: fxDesk },
        { name: 'NordTech GmbH', baseCurrency: 'EUR', dashboardName: 'DE FX', setup: fxDesk },
        { name: '', baseCurrency: 'PLN', dashboardName: 'ignored', setup: fxDesk },
      ],
    });

    expect(next.entities).toHaveLength(2);
    expect(next.group?.name).toBe('NordTech Holdings');
    expect(next.group?.includedEntityIds).toHaveLength(2);
    expect(next.entities[0].dashboards[0].name).toBe('US FX');
    expect(next.entities[0].dashboards[0].riskProfiles[0].type).toBe('fx');
    expect(next.entities[0].dashboards[0].riskProfiles[0].fxConfig?.decisionLayers).toEqual([
      'hedging',
    ]);
  });

  it('persists the wizard setup so guided desks match created ones', () => {
    const next = applyStructureWizard(emptyWorkspace(), {
      groupName: 'NordTech Holdings',
      reportingCurrency: 'USD',
      subsidiaries: [
        { name: 'NordTech US', baseCurrency: 'USD', dashboardName: 'US FX', setup: fxDesk },
      ],
    });

    const dash = next.entities[0].dashboards[0];
    expect(dash.setup).toEqual(fxDesk);
    // dashboardSetupFromDashboard must round-trip rather than re-infer.
    expect(dashboardSetupFromDashboard(dash)).toEqual(fxDesk);
    expect(dash.riskProfiles[0].fxConfig?.currencies).toEqual(['EUR', 'GBP', 'JPY']);
    expect(groupFxUnlocked(next)).toBe(true);
  });

  it('seeds a non-FX class desk without pretending it is a Cash/FX book', () => {
    const next = applyStructureWizard(emptyWorkspace(), {
      groupName: 'Commodity Group',
      reportingCurrency: 'USD',
      subsidiaries: [
        {
          name: 'Metals Co',
          baseCurrency: 'USD',
          dashboardName: 'Metals desk',
          setup: {
            riskAsset: 'commodities',
            protect: ['assetValue'],
            optimize: ['var'],
            tickers: ['XAU'],
          },
        },
      ],
    });

    const dash = next.entities[0].dashboards[0];
    expect(dash.riskProfiles[0].type).toBe('commodities');
    // No Cash/FX book, so consolidation stays locked.
    expect(groupFxUnlocked(next)).toBe(false);
  });

  it('still accepts a raw fxConfig from callers that hold one', () => {
    const next = applyStructureWizard(emptyWorkspace(), {
      groupName: 'Legacy Group',
      reportingCurrency: 'USD',
      subsidiaries: [
        {
          name: 'Legacy Co',
          baseCurrency: 'USD',
          dashboardName: 'Legacy FX',
          fxConfig: defaultCurriculumFxConfig(),
        },
      ],
    });

    expect(next.entities[0].dashboards[0].riskProfiles[0].type).toBe('fx');
    expect(groupFxUnlocked(next)).toBe(true);
  });
});

describe('workspace curriculum bridge', () => {
  it('maps WorkspaceGroup to sandbox group.dashboard', () => {
    const mapped = workspaceGroupToSandboxGroup({
      name: 'NordTech Holdings',
      reportingCurrency: 'USD',
      dashboardName: 'Group FX (consolidated)',
      includedEntityIds: ['ent_a', 'ent_b'],
    });

    expect(mapped.name).toBe('NordTech Holdings');
    expect(mapped.reportingCurrency).toBe('USD');
    expect(mapped.dashboard.name).toBe('Group FX (consolidated)');
    expect(mapped.dashboard.opened).toBe(false);
    expect(mapped.dashboard.includedEntityIds).toEqual(['ent_a', 'ent_b']);
    expect(mapped.dashboard.id).toMatch(/^grp-dash-/);
  });

  it('applies workbench structure onto sandbox state', () => {
    const workbench = applyStructureWizard(emptyWorkspace(), {
      groupName: 'Live Group',
      reportingCurrency: 'EUR',
      groupDashboardName: 'Consolidated FX',
      subsidiaries: [
        {
          name: 'Entity Alpha',
          baseCurrency: 'EUR',
          dashboardName: 'Alpha FX',
          setup: {
            riskAsset: 'currencies',
            protect: ['assetValue'],
            optimize: ['var', 'hedgeCarry'],
            tickers: ['EUR'],
          },
        },
      ],
    });

    const seeded = seedSandbox('01');
    const merged = applyWorkbenchStructureToSandbox(seeded, workbench);

    expect(merged.workspace.entities).toHaveLength(1);
    expect(merged.workspace.entities[0].name).toBe('Entity Alpha');
    expect(merged.group.name).toBe('Live Group');
    expect(merged.group.dashboard?.name).toBe('Consolidated FX');
    expect(merged.group.dashboard?.includedEntityIds).toEqual(
      workbench.group?.includedEntityIds,
    );
    expect(merged.progress.steps.buildWorkspace).toBe('done');
  });
});

describe('createDashboardFromWizard', () => {
  it('maps protect/optimize/tickers into FX profile + dashboard.setup', () => {
    const { workspace: withEnt, entity } = createEntity(emptyWorkspace(), {
      name: 'Deel US',
      baseCurrency: 'USD',
      riskAssets: ['currencies'],
    });
    const { workspace, dashboard, profile } = createDashboardFromWizard(withEnt, entity.id, {
      name: 'Currencies desk',
      setup: {
        riskAsset: 'currencies',
        protect: ['assetValue', 'liquidity'],
        optimize: ['var', 'hedgeCarry'],
        tickers: ['EUR', 'PLN'],
      },
    });

    expect(dashboard.name).toBe('Currencies desk');
    expect(dashboard.setup?.riskAsset).toBe('currencies');
    expect(dashboard.setup?.tickers).toEqual(['EUR', 'PLN']);
    expect(profile.type).toBe('fx');
    expect(profile.fxConfig?.currencies).toEqual(['EUR', 'PLN']);
    expect(profile.fxConfig?.analyticalLayers).toContain('riskMetrics');
    expect(profile.fxConfig?.decisionLayers).toContain('hedging');
    expect(profile.fxConfig?.inputs).toContain('liquidity');
    expect(workspace.entities[0].dashboards).toHaveLength(1);
  });

  it('builds fxConfigFromDashboardSetup with selected currency mode', () => {
    const cfg = fxConfigFromDashboardSetup({
      riskAsset: 'currencies',
      protect: ['cashFlow'],
      optimize: ['cfar'],
      tickers: ['GBP'],
    });
    expect(cfg.currencyMode).toBe('selected');
    expect(cfg.currencies).toEqual(['GBP']);
    expect(cfg.optimizationMetrics).toContain('carryTarget');
    expect(cfg.optimizationMetrics).toContain('cfarCover');
  });

  it('updates an existing dashboard via wizard edit workflow', () => {
    const { workspace: withEnt, entity } = createEntity(emptyWorkspace(), {
      name: 'Deel EU',
      baseCurrency: 'EUR',
      riskAssets: ['currencies'],
    });
    const created = createDashboardFromWizard(withEnt, entity.id, {
      name: 'EU FX',
      setup: {
        riskAsset: 'currencies',
        protect: ['assetValue'],
        optimize: ['var'],
        tickers: ['EUR'],
      },
    });
    const updated = updateDashboardFromWizard(
      created.workspace,
      entity.id,
      created.dashboard.id,
      {
        name: 'EU Currencies desk',
        setup: {
          riskAsset: 'currencies',
          protect: ['assetValue', 'cashFlow', 'liquidity'],
          optimize: ['var', 'hedgeCarry', 'cfar'],
          tickers: ['EUR', 'PLN', 'GBP'],
        },
      },
    );
    expect(updated.dashboard.name).toBe('EU Currencies desk');
    expect(updated.dashboard.setup?.protect).toContain('liquidity');
    expect(updated.dashboard.setup?.tickers).toEqual(['EUR', 'PLN', 'GBP']);
    expect(updated.profile.fxConfig?.currencies).toEqual(['EUR', 'PLN', 'GBP']);
    const inferred = dashboardSetupFromDashboard(updated.dashboard);
    expect(inferred.optimize).toContain('cfar');
  });
});

describe('rate instruments', () => {
  it('only offers the instruments step on rates desks', () => {
    expect(supportsInstruments('interestRates')).toBe(true);
    expect(supportsInstruments('currencies')).toBe(false);
  });

  it('prefills a floating leg with the currency convention', () => {
    const deposit = createRateInstrument('moneyMarketFund', 'EUR');
    expect(deposit.rateType).toBe('floating');
    expect(deposit.index).toBe('EURIBOR');
    expect(defaultRateIndex('gbp')).toBe('SONIA');
    expect(defaultRateIndex('ZAR')).toBeUndefined();
  });

  it('leaves the index off a fixed leg and gives cross-currency a second leg', () => {
    const fra = createRateInstrument('fra', 'USD');
    expect(fra.rateType).toBe('fixed');
    expect(fra.index).toBeUndefined();
    expect(fra.tenorMonths).toBe(3);

    const ccs = createRateInstrument('crossCurrencySwap', 'USD');
    expect(ccs.legCurrency).toBe('EUR');
    expect(createRateInstrument('crossCurrencySwap', 'EUR').legCurrency).toBe('USD');
  });

  it('gives every row its own id so a book can hold two loans', () => {
    const eur = createRateInstrument('loan', 'EUR');
    const usd = createRateInstrument('loan', 'USD');
    expect(eur.uid).not.toBe(usd.uid);
  });

  it('reads a rates desk ticker list off the instruments, deduped', () => {
    const eurLoan = createRateInstrument('loan', 'EUR');
    const usdLoan = createRateInstrument('loan', 'USD');
    const usdSwap = createRateInstrument('irs', 'USD');
    const fixedFra = createRateInstrument('fra', 'USD');

    expect(tickersFromInstruments([eurLoan, usdLoan, usdSwap])).toEqual(['EURIBOR', 'SOFR']);
    // A fixed leg has no index, so it contributes nothing to the curve.
    expect(tickersFromInstruments([fixedFra])).toEqual([]);
  });

  it('round-trips instruments through create and edit', () => {
    const { workspace: withEnt, entity } = createEntity(emptyWorkspace(), {
      name: 'Deel Treasury',
      baseCurrency: 'EUR',
      riskAssets: ['interestRates'],
    });
    const loan = { ...createRateInstrument('loan', 'EUR'), spreadBp: 75 };
    const swap = createRateInstrument('irs', 'USD');
    const created = createDashboardFromWizard(withEnt, entity.id, {
      name: 'Rates desk',
      setup: {
        riskAsset: 'interestRates',
        protect: ['cashFlow'],
        optimize: ['var'],
        tickers: ['SOFR', 'EURIBOR'],
        instruments: [loan, swap],
      },
    });

    expect(created.dashboard.setup?.instruments).toHaveLength(2);
    expect(created.profile.type).toBe('bonds');

    const reopened = dashboardSetupFromDashboard(created.dashboard);
    expect(reopened.instruments?.[0].spreadBp).toBe(75);
    expect(reopened.instruments?.[0].index).toBe('EURIBOR');

    const updated = updateDashboardFromWizard(
      created.workspace,
      entity.id,
      created.dashboard.id,
      { name: 'Rates desk', setup: { ...reopened, instruments: [loan] } },
    );
    expect(updated.dashboard.setup?.instruments).toHaveLength(1);
  });
});

describe('saveWorkspace error path', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ok:false when localStorage.setItem throws', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });

    const ws: Workspace = { entities: [] };
    const result = saveWorkspace('user-test', ws);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/QuotaExceededError|full|blocked/i);
  });

  it('returns ok:true when localStorage accepts the write', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
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

    const result = saveWorkspace('user-test', { entities: [] });
    expect(result.ok).toBe(true);
    expect(store.size).toBe(1);
  });
});
