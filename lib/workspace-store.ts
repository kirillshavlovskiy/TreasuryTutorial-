// Workspace data model + persistence for the entity / dashboard / risk-profile
// workflow. Persistence is client-side (localStorage), scoped per signed-in
// user. This is a prototype layer: the same shape maps cleanly onto a
// PostgreSQL + Sequelize backend (Entity → Dashboard → RiskProfile tables)
// when server persistence is introduced.

import type { LayerId } from '@/lib/fx-buffer';
import type { ForecastProfileState } from '@/lib/forecast-profile';
import { migrateFormulaOverrides } from '@/lib/sim-formulas';

export type RiskProfileType = 'fx' | 'bonds' | 'investments' | 'equities' | 'commodities';

export const RISK_PROFILE_TYPES: {
  id: RiskProfileType;
  label: string;
  description: string;
  /** When false, chip is visible but disabled (coming soon). */
  available: boolean;
}[] = [
  { id: 'fx',           label: 'Cash/FX',                description: 'Foreign-exchange cash buffers, carry and hedging (FX Simulator template).', available: true },
  { id: 'bonds',        label: 'Bonds / Interest Rates', description: 'Fixed-income duration, DV01 and rate exposure (stub profile).',            available: true },
  { id: 'investments',  label: 'Investments',            description: 'Interest-earning asset book and investment risk (stub profile).',          available: true },
  { id: 'equities',     label: 'Equities',               description: 'Equity portfolio risk and exposure (stub profile).',                       available: true },
  { id: 'commodities',  label: 'Commodities',            description: 'Commodity price and hedging exposure (stub profile).',                     available: true },
];

// FX template inputs/metrics the user opts into for a profile.
export type FxInput =
  | 'liquidity'
  | 'fxExposure'
  | 'rates'
  | 'bonds'
  | 'investments'
  | 'liabilities';

export const FX_INPUTS: { id: FxInput; label: string; description: string }[] = [
  { id: 'liquidity',    label: 'Liquidity',    description: 'Cash balances and payout liquidity buffers.' },
  { id: 'fxExposure',   label: 'FX Risk',      description: 'Net TMS FX book position per currency.' },
  { id: 'rates',        label: 'Rates',        description: 'LP credit / debit rates and carry differentials.' },
  { id: 'bonds',        label: 'Bonds',        description: 'Fixed-rate instrument notionals in the IR profile.' },
  { id: 'investments',  label: 'Investments',  description: 'Interest-earning asset positions.' },
  { id: 'liabilities',  label: 'Liabilities',  description: 'Funding / overdraft liabilities.' },
];

// Optimization metrics → simulator layers.
export type OptMetric = 'minFloor' | 'payoutBuffer' | 'carryTarget' | 'portfolioVar' | 'cfarCover';

export const OPT_METRICS: { id: OptMetric; label: string; layer: LayerId; description: string }[] = [
  { id: 'minFloor',     label: 'Min Floor',      layer: 'floorH',       description: 'Hard per-currency minimum cash floor.' },
  { id: 'payoutBuffer', label: 'Payout Buffer',  layer: 'sigmaP',       description: 'Forecast-uncertainty (σ_P) safety margin on payouts.' },
  { id: 'cfarCover',    label: 'CFaR Cover',     layer: 'cfarCover',    description: 'Liquidity swap sized from FX-only Net CFaR; displayed CFaR also prices the funding-swap bridge.' },
  { id: 'carryTarget',  label: 'Carry Target',   layer: 'carryOptim',   description: 'Rate-differential carry optimisation.' },
  { id: 'portfolioVar', label: 'Portfolio VaR',  layer: 'portfolioDiv', description: 'Diversified portfolio VaR budget across currencies.' },
];

/**
 * Task Mode FX inputs / metrics row: only Liquidity (inactive), FX Risk (active),
 * plus DV01 / Greeks extras (inactive). All other FX_INPUTS / OPT_METRICS stay out of the UI.
 */
export const TASK01_INACTIVE_FX_INPUTS: readonly FxInput[] = ['liquidity'] as const;

/** Extra inactive chips (not wired to FxInput / OptMetric yet). */
export const TASK01_INACTIVE_EXTRA_METRICS: readonly { id: string; label: string; description: string }[] = [
  { id: 'dv01', label: 'DV01', description: 'Interest-rate sensitivity (IR Profile) — coming soon in Task Mode.' },
  { id: 'greeks', label: 'Greeks', description: 'Option Greeks / delta-gamma risk — coming soon in Task Mode.' },
];

/**
 * Decision layer — actionable hedge sizing.
 * Delta = 1 means fully unhedged; add hedge to reduce delta and VaR.
 */
export type DecisionLayer = 'hedging';

export const DECISION_LAYERS: {
  id: DecisionLayer;
  label: string;
  description: string;
}[] = [
  {
    id: 'hedging',
    label: 'Hedging Decision',
    description:
      'Size the hedge from delta = 1 (unhedged) and read residual exposure + VaR per currency.',
  },
];

/**
 * Analytical layer — risk / sensitivity / scenario tools on the dashboard.
 */
export type AnalyticalLayer = 'sensitivity' | 'riskMetrics' | 'monteCarlo';

export const ANALYTICAL_LAYERS: {
  id: AnalyticalLayer;
  label: string;
  description: string;
  available: boolean;
}[] = [
  {
    id: 'sensitivity',
    label: 'Sensitivity',
    description: 'Buffer and rate sensitivity analysis (blocked in Test Mode).',
    available: false,
  },
  {
    id: 'riskMetrics',
    label: 'Risk Metrics (VaR)',
    description: '1M 95% VaR per currency on stock FX exposure (table + panel).',
    available: true,
  },
  {
    id: 'monteCarlo',
    label: 'Monte Carlo',
    description: 'Stochastic path analysis (coming soon).',
    available: false,
  },
];

/** Map selected optimization metrics to simulator layer ids. */
export function metricsToLayers(metrics: OptMetric[]): LayerId[] {
  return OPT_METRICS.filter(m => metrics.includes(m.id)).map(m => m.layer);
}

export interface FxProfileConfig {
  inputs: FxInput[];
  currencyMode: 'all' | 'selected';
  currencies: string[];
  optimizationMetrics: OptMetric[];
  /** Decision layers (e.g. Hedging Decision). */
  decisionLayers?: DecisionLayer[];
  /** Analytical layers (Sensitivity, Risk Metrics / VaR, Monte Carlo). */
  analyticalLayers?: AnalyticalLayer[];
}

export interface RiskProfile {
  id: string;
  type: RiskProfileType;
  name: string;
  createdAt: string;
  fxConfig?: FxProfileConfig;
}

// ── Timing / calendar model ──────────────────────────────────────────────────
// Payin / payout distribution across the calc cycle drives when cash is on the
// books and therefore how much carry (interest) it earns. A flow that lands at
// the very end of the cycle earns no carry; one at the start earns the full run.
export type FlowTiming = 'start' | 'mid' | 'end' | 'custom';

export interface TimingProfile {
  mode: 'preset' | 'calendar';
  /** When payouts leave, as a preset point in the cycle. Default 'mid' (mid-month). */
  payout: FlowTiming;
  /** When payins arrive. Default 'end' (EOM). */
  payin: FlowTiming;
  /** Custom point (% of cycle elapsed, 0–100) used when payout/payin === 'custom'. */
  payoutCustom: number;
  payinCustom: number;
  /** Calendar dates (mode === 'calendar'); fractions are derived from these. */
  periodStart?: string;
  periodEnd?: string;
  payoutDate?: string;
  payinDate?: string;
}

export const DEFAULT_TIMING: TimingProfile = {
  mode: 'preset',
  payout: 'mid',
  payin: 'end',
  payoutCustom: 50,
  payinCustom: 100,
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function presetFraction(t: FlowTiming, custom: number): number {
  switch (t) {
    case 'start':  return 0;
    case 'mid':    return 0.5;
    case 'end':    return 1;
    case 'custom': return clamp01(custom / 100);
  }
}

/**
 * Resolve a timing profile to the fraction of the cycle elapsed BEFORE each flow
 * lands (0 = start, 1 = end). Carry weight for a flow is (1 − fraction).
 */
export function resolveTimingFractions(t: TimingProfile): { fPayout: number; fPayin: number } {
  if (t.mode === 'calendar' && t.periodStart && t.periodEnd) {
    const start = new Date(t.periodStart).getTime();
    const end = new Date(t.periodEnd).getTime();
    const span = end - start;
    const frac = (d?: string): number | undefined => {
      if (!d || !(span > 0)) return undefined;
      return clamp01((new Date(d).getTime() - start) / span);
    };
    return {
      fPayout: frac(t.payoutDate) ?? presetFraction(t.payout, t.payoutCustom),
      fPayin:  frac(t.payinDate)  ?? presetFraction(t.payin, t.payinCustom),
    };
  }
  return {
    fPayout: presetFraction(t.payout, t.payoutCustom),
    fPayin:  presetFraction(t.payin, t.payinCustom),
  };
}

/** Risk asset class for entity / dashboard create wizard (one dashboard = one asset). */
export type RiskAssetId =
  | 'currencies'
  | 'interestRates'
  | 'bonds'
  | 'investments'
  | 'commodities'
  | 'realAssets';

export type ProtectGoalId =
  | 'assetValue'
  | 'cashFlow'
  | 'liquidity'
  | 'credit'
  | 'earnings';

export type OptimizeFrameworkId =
  | 'var'
  | 'cfar'
  | 'ear'
  | 'dv01'
  | 'greeks'
  | 'factorModel'
  | 'credit'
  | 'hedgeCarry';

export const RISK_ASSETS: {
  id: RiskAssetId;
  label: string;
  live: boolean;
  profileType: RiskProfileType;
}[] = [
  { id: 'currencies', label: 'Currencies', live: true, profileType: 'fx' },
  { id: 'interestRates', label: 'Interest rates', live: true, profileType: 'bonds' },
  { id: 'bonds', label: 'Bonds', live: false, profileType: 'bonds' },
  { id: 'investments', label: 'Investments', live: false, profileType: 'investments' },
  { id: 'commodities', label: 'Commodities', live: false, profileType: 'commodities' },
  { id: 'realAssets', label: 'Real assets', live: false, profileType: 'investments' },
];

export const PROTECT_GOALS: { id: ProtectGoalId; label: string }[] = [
  { id: 'assetValue', label: 'Asset value' },
  { id: 'cashFlow', label: 'Cash flow' },
  { id: 'liquidity', label: 'Liquidity' },
  { id: 'credit', label: 'Credit' },
  { id: 'earnings', label: 'Earnings' },
];

export const OPTIMIZE_FRAMEWORKS: {
  id: OptimizeFrameworkId;
  /** Short form for the wizard's narrow select cards. */
  label: string;
  /** Spelled out — what desk summaries show, since the acronyms are opaque. */
  longLabel: string;
  live: boolean;
  /** When set, only offer for this risk asset (else all). */
  assets?: RiskAssetId[];
}[] = [
  { id: 'var', label: 'VaR', longLabel: 'Value at Risk', live: true },
  { id: 'cfar', label: 'CFaR', longLabel: 'Cash Flow at Risk', live: true },
  { id: 'ear', label: 'EaR', longLabel: 'Earnings at Risk', live: false },
  {
    id: 'dv01',
    label: 'DV01',
    longLabel: 'Dollar value of 1bp',
    live: false,
    assets: ['interestRates', 'bonds'],
  },
  {
    id: 'greeks',
    label: 'Greeks',
    longLabel: 'Option Greeks',
    live: false,
    assets: ['currencies'],
  },
  { id: 'factorModel', label: 'Factor model', longLabel: 'Factor model', live: false },
  { id: 'credit', label: 'Credit', longLabel: 'Credit exposure', live: false },
  {
    id: 'hedgeCarry',
    label: 'Hedge / carry',
    longLabel: 'Hedge cost / carry',
    live: true,
    assets: ['currencies'],
  },
];

/** Wizard choices persisted on the dashboard (desk create flow). */
/**
 * Instruments a rates desk can hold. Cash instruments are the exposure itself;
 * derivatives are what the desk hedges it with.
 */
export type RateInstrumentKind =
  | 'timeDeposit'
  | 'loan'
  | 'moneyMarketFund'
  | 'irs'
  | 'swaption'
  | 'fra'
  | 'crossCurrencySwap';

export type RateLegType = 'fixed' | 'floating';

export const RATE_INSTRUMENTS: {
  id: RateInstrumentKind;
  label: string;
  group: 'cash' | 'derivative';
  /** Legs the instrument can carry — a money market fund only ever floats. */
  rateTypes: RateLegType[];
  /** Carries a second currency leg (cross-currency swap). */
  dualCurrency?: boolean;
  hint: string;
}[] = [
  {
    id: 'timeDeposit',
    label: 'Time deposit',
    group: 'cash',
    rateTypes: ['fixed', 'floating'],
    hint: 'Term cash placed with a bank',
  },
  {
    id: 'loan',
    label: 'Loan',
    group: 'cash',
    rateTypes: ['floating', 'fixed'],
    hint: 'Drawn borrowing or intercompany loan',
  },
  {
    id: 'moneyMarketFund',
    label: 'Money market fund',
    group: 'cash',
    rateTypes: ['floating'],
    hint: 'MMF / short-dated investment, yield floats',
  },
  {
    id: 'irs',
    label: 'Interest rate swap',
    group: 'derivative',
    rateTypes: ['fixed', 'floating'],
    hint: 'Swap the coupon between fixed and floating',
  },
  {
    id: 'swaption',
    label: 'Swaption',
    group: 'derivative',
    rateTypes: ['fixed', 'floating'],
    hint: 'Option to enter a swap at a strike rate',
  },
  {
    id: 'fra',
    label: 'FRA',
    group: 'derivative',
    rateTypes: ['fixed'],
    hint: 'Forward rate agreement on a single period',
  },
  {
    id: 'crossCurrencySwap',
    label: 'Cross-currency swap',
    group: 'derivative',
    rateTypes: ['floating', 'fixed'],
    dualCurrency: true,
    hint: 'Rate and currency legs swapped together',
  },
];

/**
 * One instrument in a desk's scope. Kinds repeat — a book can hold a EUR loan
 * and a USD loan — so rows carry their own id rather than keying off the kind.
 */
export interface RateInstrument {
  uid: string;
  kind: RateInstrumentKind;
  currency: string;
  /** For derivatives this is the leg the desk pays. */
  rateType: RateLegType;
  /** Reference index for a floating leg (SOFR, EURIBOR, …). */
  index?: string;
  /** Fixed coupon / strike, in percent. */
  ratePct?: number;
  /** Floating spread over the index, in basis points. */
  spreadBp?: number;
  tenorMonths?: number;
  /** Cross-currency swaps only — the currency of the receive leg. */
  legCurrency?: string;
}

/** Conventional overnight/term index per currency, so floating legs prefill. */
const RATE_INDEX_BY_CURRENCY: Record<string, string> = {
  USD: 'SOFR',
  EUR: 'EURIBOR',
  GBP: 'SONIA',
  JPY: 'TONA',
  CHF: 'SARON',
  PLN: 'WIBOR',
};

export function defaultRateIndex(currency: string): string | undefined {
  return RATE_INDEX_BY_CURRENCY[currency.trim().toUpperCase()];
}

/** Only rates desks scope instruments today; other assets pick tickers instead. */
export function supportsInstruments(asset: RiskAssetId): boolean {
  return asset === 'interestRates';
}

/**
 * A rates desk states its curve through its instruments rather than a ticker
 * step, so its tickers are the indices its floating legs reference.
 */
export function tickersFromInstruments(instruments: RateInstrument[]): string[] {
  return [...new Set(instruments.map(i => i.index).filter(Boolean) as string[])];
}

export function createRateInstrument(
  kind: RateInstrumentKind,
  currency: string,
): RateInstrument {
  const meta = RATE_INSTRUMENTS.find(i => i.id === kind);
  const rateType = meta?.rateTypes[0] ?? 'fixed';
  return {
    uid: makeId('inst'),
    kind,
    currency,
    rateType,
    index: rateType === 'floating' ? defaultRateIndex(currency) : undefined,
    tenorMonths: kind === 'fra' ? 3 : 12,
    legCurrency: meta?.dualCurrency ? (currency === 'USD' ? 'EUR' : 'USD') : undefined,
  };
}

export interface DashboardSetup {
  riskAsset: RiskAssetId;
  protect: ProtectGoalId[];
  optimize: OptimizeFrameworkId[];
  tickers: string[];
  /** Rates desks only — instruments in scope, each with its own currency and terms. */
  instruments?: RateInstrument[];
}

export interface Dashboard {
  id: string;
  name: string;
  createdAt: string;
  riskProfiles: RiskProfile[];
  timing?: TimingProfile;
  /** Per-cell formula overrides for the FX simulator, keyed `${ccy}::${fieldKey}`. */
  formulas?: Record<string, string>;
  /**
   * Forecast profile: monthly flow schedule, cash extras, growth, and the
   * liquidity path (per-line settlement windows, granularity, sizing basis).
   * `timing` above is the coarse carry preset and does not cover any of it.
   */
  forecastProfile?: ForecastProfileState;
  /** Create-dashboard wizard selections (risk asset · protect · optimize · tickers). */
  setup?: DashboardSetup;
}

export interface Entity {
  id: string;
  name: string;
  baseCurrency: string;
  description: string;
  createdAt: string;
  dashboards: Dashboard[];
  /** Risk assets enabled for this entity (drives Create dashboard step 1). */
  riskAssets?: RiskAssetId[];
}

/**
 * Parent / consolidated group metadata (Workbench + Sandbox-compatible).
 * Legal entities remain a flat `entities[]` list; the group is the curriculum-style
 * "Parent · consolidated" layer that unlocks once subsidiaries have dashboards + FX profiles.
 */
export interface WorkspaceGroup {
  name: string;
  reportingCurrency: string;
  /** Dashboard label for the consolidated Group FX view. */
  dashboardName: string;
  includedEntityIds: string[];
}

export interface Workspace {
  entities: Entity[];
  group?: WorkspaceGroup | null;
}

/** One subsidiary drafted in the Structure Wizard before materialization. */
export interface StructureWizardSubsidiary {
  name: string;
  baseCurrency: string;
  description?: string;
  dashboardName: string;
  /**
   * Desk definition in the same shape the create-dashboard wizard produces
   * (risk asset · protect · optimize · tickers). Guided setup and the single
   * dashboard flow therefore land on identical dashboards.
   */
  setup?: DashboardSetup;
  /** Escape hatch for callers that already hold a raw profile config. */
  fxConfig?: FxProfileConfig;
}

export interface StructureWizardInput {
  groupName: string;
  reportingCurrency: string;
  groupDashboardName?: string;
  subsidiaries: StructureWizardSubsidiary[];
}

/** Default FX profile matching curriculum Task 01 structure (result checklist). */
export function defaultCurriculumFxConfig(): FxProfileConfig {
  return {
    inputs: ['fxExposure'],
    currencyMode: 'all',
    currencies: [],
    optimizationMetrics: ['minFloor', 'payoutBuffer', 'carryTarget', 'portfolioVar'],
    decisionLayers: ['hedging'],
    analyticalLayers: ['riskMetrics'],
  };
}

/**
 * Materialize a guided structure: parent group + subsidiaries, each with a
 * dashboard and Cash/FX metrics profile — the same shape curriculum Validate scores.
 */
export function applyStructureWizard(
  workspace: Workspace,
  input: StructureWizardInput,
): Workspace {
  const groupName = input.groupName.trim() || 'Group';
  const reportingCurrency = input.reportingCurrency || 'USD';
  const groupDashboardName =
    input.groupDashboardName?.trim() || 'Group FX (consolidated)';

  let ws: Workspace = { ...workspace, entities: [...workspace.entities] };
  const createdIds: string[] = [];

  for (const sub of input.subsidiaries) {
    const name = sub.name.trim();
    if (!name) continue;
    const setup = sub.setup;
    const ent = createEntity(ws, {
      name,
      baseCurrency: sub.baseCurrency || reportingCurrency,
      description: sub.description,
      riskAssets: [
        ...new Set<RiskAssetId>([
          ...(setup ? [setup.riskAsset] : []),
          'currencies',
          'interestRates',
        ]),
      ],
    });
    ws = ent.workspace;
    createdIds.push(ent.entity.id);

    const dashName = sub.dashboardName.trim() || `${name} FX`;
    // Persisting the setup is what makes the desk cards render protect /
    // optimize / tickers — without it a guided desk looks half-configured.
    const dash = createDashboard(ws, ent.entity.id, dashName, setup);
    ws = dash.workspace;

    // Same branch as createDashboardFromWizard: currencies seed a live Cash/FX
    // profile, other asset classes a stub for their class. Group FX only
    // unlocks off Cash/FX, which is why the wizard defaults to currencies.
    const asset = setup ? RISK_ASSETS.find(a => a.id === setup.riskAsset) : undefined;
    const profile = createRiskProfile(
      ws,
      ent.entity.id,
      dash.dashboard.id,
      !setup || setup.riskAsset === 'currencies'
        ? {
            type: 'fx',
            name: 'Cash/FX',
            fxConfig:
              (setup ? fxConfigFromDashboardSetup(setup) : sub.fxConfig)
              ?? defaultCurriculumFxConfig(),
          }
        : {
            type: asset?.profileType ?? 'investments',
            name: asset?.label ?? 'Dashboard',
          },
    );
    ws = profile.workspace;
  }

  ws = {
    ...ws,
    group: {
      name: groupName,
      reportingCurrency,
      dashboardName: groupDashboardName,
      includedEntityIds: createdIds,
    },
  };
  return ws;
}

/** True when an entity has at least one dashboard with a Cash/FX risk profile. */
export function entityHasFxSetup(entity: Entity): boolean {
  return entity.dashboards.some(d => d.riskProfiles.some(p => p.type === 'fx'));
}

const STORAGE_PREFIX = 'treasury:workspace:';

function storageKey(userKey: string): string {
  return `${STORAGE_PREFIX}${userKey}`;
}

export function emptyWorkspace(): Workspace {
  return { entities: [] };
}

export interface WorkspaceLoadResult {
  workspace: Workspace;
  /** True when localStorage was unreadable / corrupt and we fell back to empty. */
  loadWarning?: string;
}

export interface WorkspaceSaveResult {
  ok: boolean;
  error?: string;
}

/**
 * Rewrite formula overrides saved under the pre-Liquidity-Pool field names.
 * Runs on every load rather than as a one-off flag: workspaces live in
 * localStorage per browser, so there is no upgrade moment at which every
 * copy can be known to have been converted. Returns the input untouched when
 * nothing matches, keeping the common path allocation-free.
 */
function migrateRenamedFormulaRefs(workspace: Workspace): Workspace {
  let touched = false;
  const entities = workspace.entities.map(entity => {
    const dashboards = entity.dashboards?.map(dashboard => {
      if (!dashboard.formulas) return dashboard;
      const migrated = migrateFormulaOverrides(dashboard.formulas);
      if (migrated === dashboard.formulas) return dashboard;
      touched = true;
      return { ...dashboard, formulas: migrated };
    });
    return dashboards === entity.dashboards ? entity : { ...entity, dashboards };
  });
  return touched ? { ...workspace, entities } : workspace;
}

/** Read the full workspace for a user. Safe on the server (returns empty). */
export function loadWorkspace(userKey: string): Workspace {
  return loadWorkspaceDetailed(userKey).workspace;
}

/** Load with an optional warning when storage is corrupt or unavailable. */
export function loadWorkspaceDetailed(userKey: string): WorkspaceLoadResult {
  if (typeof window === 'undefined') return { workspace: emptyWorkspace() };
  try {
    const raw = window.localStorage.getItem(storageKey(userKey));
    if (!raw) return { workspace: emptyWorkspace() };
    const parsed = JSON.parse(raw) as Workspace;
    if (!parsed || !Array.isArray(parsed.entities)) {
      return {
        workspace: emptyWorkspace(),
        loadWarning: 'Saved workspace was unreadable — started with an empty book.',
      };
    }
    return { workspace: migrateRenamedFormulaRefs(parsed) };
  } catch {
    return {
      workspace: emptyWorkspace(),
      loadWarning: 'Could not read workspace from browser storage — started empty.',
    };
  }
}

/** Persist workspace to localStorage. Returns ok/error instead of throwing. */
export function saveWorkspace(
  userKey: string,
  workspace: Workspace,
): WorkspaceSaveResult {
  if (typeof window === 'undefined') {
    return { ok: false, error: 'Workspace save is only available in the browser.' };
  }
  try {
    window.localStorage.setItem(storageKey(userKey), JSON.stringify(workspace));
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Browser storage is full or blocked.';
    return { ok: false, error: message };
  }
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createEntity(
  workspace: Workspace,
  input: {
    name: string;
    baseCurrency: string;
    description?: string;
    riskAssets?: RiskAssetId[];
  },
): { workspace: Workspace; entity: Entity } {
  const entity: Entity = {
    id: makeId('ent'),
    name: input.name.trim(),
    baseCurrency: input.baseCurrency,
    description: input.description?.trim() ?? '',
    createdAt: new Date().toISOString(),
    dashboards: [],
    riskAssets: input.riskAssets,
  };
  return { workspace: { ...workspace, entities: [...workspace.entities, entity] }, entity };
}

export function createDashboard(
  workspace: Workspace,
  entityId: string,
  name: string,
  setup?: DashboardSetup,
): { workspace: Workspace; dashboard: Dashboard } {
  const dashboard: Dashboard = {
    id: makeId('dash'),
    name: name.trim(),
    createdAt: new Date().toISOString(),
    riskProfiles: [],
    timing: DEFAULT_TIMING,
    setup,
  };
  const entities = workspace.entities.map(e =>
    e.id === entityId ? { ...e, dashboards: [...e.dashboards, dashboard] } : e,
  );
  return { workspace: { ...workspace, entities }, dashboard };
}

/** Map Create-dashboard wizard optimize/protect picks → Cash/FX profile config. */
export function fxConfigFromDashboardSetup(setup: DashboardSetup): FxProfileConfig {
  const inputs: FxInput[] = ['fxExposure'];
  if (setup.protect.includes('liquidity')) inputs.push('liquidity');
  if (setup.protect.includes('cashFlow') || setup.optimize.includes('hedgeCarry')) {
    if (!inputs.includes('rates')) inputs.push('rates');
  }

  const optimizationMetrics: OptMetric[] = [];
  if (setup.optimize.includes('var') || setup.protect.includes('assetValue')) {
    optimizationMetrics.push('portfolioVar', 'minFloor', 'payoutBuffer');
  }
  if (setup.optimize.includes('hedgeCarry') || setup.optimize.includes('cfar')) {
    optimizationMetrics.push('carryTarget');
  }
  if (setup.optimize.includes('cfar')) {
    optimizationMetrics.push('cfarCover');
  }
  if (optimizationMetrics.length === 0) {
    optimizationMetrics.push(...defaultCurriculumFxConfig().optimizationMetrics);
  }

  const decisionLayers: DecisionLayer[] =
    setup.optimize.includes('hedgeCarry') || setup.protect.includes('cashFlow')
      ? ['hedging']
      : [];
  const analyticalLayers: AnalyticalLayer[] = setup.optimize.includes('var')
    ? ['riskMetrics']
    : [];

  const unique = <T,>(xs: T[]) => [...new Set(xs)];
  return {
    inputs: unique(inputs),
    currencyMode: setup.tickers.length > 0 ? 'selected' : 'all',
    currencies: [...setup.tickers],
    optimizationMetrics: unique(optimizationMetrics),
    decisionLayers,
    analyticalLayers,
  };
}

/**
 * Create dashboard from the 4-step modal wizard and seed the matching risk profile.
 * Currencies → live Cash/FX; other assets → stub profile for that class.
 */
export function createDashboardFromWizard(
  workspace: Workspace,
  entityId: string,
  input: { name?: string; setup: DashboardSetup },
): { workspace: Workspace; dashboard: Dashboard; profile: RiskProfile } {
  const asset = RISK_ASSETS.find(a => a.id === input.setup.riskAsset);
  const label = asset?.label ?? 'Dashboard';
  const name = input.name?.trim() || `${label} desk`;
  const created = createDashboard(workspace, entityId, name, input.setup);

  const profileInput =
    input.setup.riskAsset === 'currencies'
      ? {
          type: 'fx' as const,
          name: 'Cash/FX',
          fxConfig: fxConfigFromDashboardSetup(input.setup),
        }
      : {
          type: asset?.profileType ?? ('investments' as const),
          name: label,
        };

  const res = createRiskProfile(
    created.workspace,
    entityId,
    created.dashboard.id,
    profileInput,
  );
  const dashboard =
    res.workspace.entities
      .find(e => e.id === entityId)
      ?.dashboards.find(d => d.id === created.dashboard.id) ?? created.dashboard;

  return { workspace: res.workspace, dashboard, profile: res.profile };
}

/** Risk assets offered on Create dashboard step 1 for this entity. */
export function entityEnabledRiskAssets(entity: Entity): RiskAssetId[] {
  if (entity.riskAssets && entity.riskAssets.length > 0) return entity.riskAssets;
  return RISK_ASSETS.filter(a => a.live).map(a => a.id);
}

/** Infer wizard setup from a dashboard (including legacy books without setup). */
export function dashboardSetupFromDashboard(dashboard: Dashboard): DashboardSetup {
  if (dashboard.setup) return { ...dashboard.setup, tickers: [...dashboard.setup.tickers] };

  const fx = dashboard.riskProfiles.find(p => p.type === 'fx')?.fxConfig;
  if (fx) {
    const optimize: OptimizeFrameworkId[] = [];
    if ((fx.analyticalLayers ?? []).includes('riskMetrics') || fx.optimizationMetrics.includes('portfolioVar')) {
      optimize.push('var');
    }
    if (
      (fx.decisionLayers ?? []).includes('hedging')
      || fx.optimizationMetrics.includes('carryTarget')
    ) {
      optimize.push('hedgeCarry');
    }
    if (optimize.length === 0) optimize.push('var');

    const protect: ProtectGoalId[] = ['assetValue'];
    if (fx.inputs.includes('liquidity')) protect.push('liquidity');
    if ((fx.decisionLayers ?? []).includes('hedging')) protect.push('cashFlow');

    return {
      riskAsset: 'currencies',
      protect,
      optimize,
      tickers:
        fx.currencyMode === 'selected' && fx.currencies.length > 0
          ? [...fx.currencies]
          : ['EUR', 'GBP', 'JPY'],
    };
  }

  const primary = dashboard.riskProfiles[0]?.type;
  const asset =
    RISK_ASSETS.find(a => a.profileType === primary && a.id !== 'currencies')
    ?? RISK_ASSETS.find(a => a.profileType === primary)
    ?? RISK_ASSETS[0];
  return {
    riskAsset: asset.id,
    protect: ['assetValue'],
    optimize: asset.id === 'currencies' ? ['var', 'hedgeCarry'] : ['var'],
    tickers: [],
  };
}

/**
 * Re-run Create-dashboard wizard on an existing dashboard (edit mode).
 * Updates name + setup and reseeds the primary risk profile from the wizard.
 */
export function updateDashboardFromWizard(
  workspace: Workspace,
  entityId: string,
  dashboardId: string,
  input: { name?: string; setup: DashboardSetup },
): { workspace: Workspace; dashboard: Dashboard; profile: RiskProfile } {
  const asset = RISK_ASSETS.find(a => a.id === input.setup.riskAsset);
  const label = asset?.label ?? 'Dashboard';
  const name = input.name?.trim() || `${label} desk`;

  const profile: RiskProfile =
    input.setup.riskAsset === 'currencies'
      ? {
          id: makeId('rp'),
          type: 'fx',
          name: 'Cash/FX',
          createdAt: new Date().toISOString(),
          fxConfig: fxConfigFromDashboardSetup(input.setup),
        }
      : {
          id: makeId('rp'),
          type: asset?.profileType ?? 'investments',
          name: label,
          createdAt: new Date().toISOString(),
        };

  const entities = workspace.entities.map(e => {
    if (e.id !== entityId) return e;
    return {
      ...e,
      dashboards: e.dashboards.map(d => {
        if (d.id !== dashboardId) return d;
        return {
          ...d,
          name,
          setup: input.setup,
          riskProfiles: [profile],
        };
      }),
    };
  });

  const next = { ...workspace, entities };
  const dashboard =
    next.entities.find(e => e.id === entityId)?.dashboards.find(d => d.id === dashboardId)
    ?? {
      id: dashboardId,
      name,
      createdAt: new Date().toISOString(),
      riskProfiles: [profile],
      setup: input.setup,
    };

  return { workspace: next, dashboard, profile };
}

export function createRiskProfile(
  workspace: Workspace,
  entityId: string,
  dashboardId: string,
  input: { type: RiskProfileType; name: string; fxConfig?: FxProfileConfig },
): { workspace: Workspace; profile: RiskProfile } {
  const profile: RiskProfile = {
    id: makeId('rp'),
    type: input.type,
    name: input.name.trim(),
    createdAt: new Date().toISOString(),
    fxConfig: input.fxConfig,
  };
  const entities = workspace.entities.map(e => {
    if (e.id !== entityId) return e;
    return {
      ...e,
      dashboards: e.dashboards.map(d =>
        d.id === dashboardId ? { ...d, riskProfiles: [...d.riskProfiles, profile] } : d,
      ),
    };
  });
  return { workspace: { ...workspace, entities }, profile };
}

export function updateFxProfileConfig(
  workspace: Workspace,
  entityId: string,
  dashboardId: string,
  profileId: string,
  patch: Partial<FxProfileConfig>,
): Workspace {
  const entities = workspace.entities.map(e => {
    if (e.id !== entityId) return e;
    return {
      ...e,
      dashboards: e.dashboards.map(d => {
        if (d.id !== dashboardId) return d;
        return {
          ...d,
          riskProfiles: d.riskProfiles.map(p => {
            if (p.id !== profileId || p.type !== 'fx' || !p.fxConfig) return p;
            return { ...p, fxConfig: { ...p.fxConfig, ...patch } };
          }),
        };
      }),
    };
  });
  return { ...workspace, entities };
}

export function updateDashboardTiming(
  workspace: Workspace,
  entityId: string,
  dashboardId: string,
  timing: TimingProfile,
): Workspace {
  const entities = workspace.entities.map(e => {
    if (e.id !== entityId) return e;
    return {
      ...e,
      dashboards: e.dashboards.map(d =>
        d.id === dashboardId ? { ...d, timing } : d,
      ),
    };
  });
  return { ...workspace, entities };
}

/**
 * Store the dashboard's forecast profile — monthly flows, cash extras, growth
 * and the liquidity path (settlement windows, granularity, sizing basis).
 */
export function updateDashboardForecastProfile(
  workspace: Workspace,
  entityId: string,
  dashboardId: string,
  forecastProfile: ForecastProfileState,
): Workspace {
  const entities = workspace.entities.map(e => {
    if (e.id !== entityId) return e;
    return {
      ...e,
      dashboards: e.dashboards.map(d =>
        d.id === dashboardId ? { ...d, forecastProfile } : d,
      ),
    };
  });
  return { ...workspace, entities };
}

/**
 * Set or clear a single formula override for a dashboard. Passing an empty
 * string removes the override (reverting the cell to its default formula).
 */
export function updateDashboardFormula(
  workspace: Workspace,
  entityId: string,
  dashboardId: string,
  cellKey: string,
  formula: string,
): Workspace {
  return updateDashboardFormulas(workspace, entityId, dashboardId, {
    [cellKey]: formula,
  });
}

/**
 * Batch set/clear formula overrides (used by Excel-like column fill-down so
 * every covered row lands in one state update — avoids stale-closure loss).
 * Empty string values remove the override for that cell key.
 */
export function updateDashboardFormulas(
  workspace: Workspace,
  entityId: string,
  dashboardId: string,
  updates: Record<string, string>,
): Workspace {
  const keys = Object.keys(updates);
  if (keys.length === 0) return workspace;
  const entities = workspace.entities.map(e => {
    if (e.id !== entityId) return e;
    return {
      ...e,
      dashboards: e.dashboards.map(d => {
        if (d.id !== dashboardId) return d;
        const next = { ...(d.formulas ?? {}) };
        for (const cellKey of keys) {
          const formula = updates[cellKey] ?? '';
          if (formula.trim() === '') delete next[cellKey];
          else next[cellKey] = formula.trim().replace(/^=/, '').trim();
        }
        return { ...d, formulas: next };
      }),
    };
  });
  return { ...workspace, entities };
}

export function renameEntity(
  workspace: Workspace,
  entityId: string,
  name: string,
): Workspace {
  const trimmed = name.trim();
  if (!trimmed) return workspace;
  return {
    ...workspace,
    entities: workspace.entities.map(e =>
      e.id === entityId ? { ...e, name: trimmed } : e,
    ),
  };
}

export function deleteEntity(workspace: Workspace, entityId: string): Workspace {
  const entities = workspace.entities.filter(e => e.id !== entityId);
  const group = workspace.group
    ? {
        ...workspace.group,
        includedEntityIds: workspace.group.includedEntityIds.filter(id => id !== entityId),
      }
    : workspace.group;
  return { ...workspace, entities, group };
}

export function renameDashboard(
  workspace: Workspace,
  entityId: string,
  dashboardId: string,
  name: string,
): Workspace {
  const trimmed = name.trim();
  if (!trimmed) return workspace;
  const entities = workspace.entities.map(e => {
    if (e.id !== entityId) return e;
    return {
      ...e,
      dashboards: e.dashboards.map(d =>
        d.id === dashboardId ? { ...d, name: trimmed } : d,
      ),
    };
  });
  return { ...workspace, entities };
}

export function deleteDashboard(
  workspace: Workspace,
  entityId: string,
  dashboardId: string,
): Workspace {
  const entities = workspace.entities.map(e =>
    e.id === entityId
      ? { ...e, dashboards: e.dashboards.filter(d => d.id !== dashboardId) }
      : e,
  );
  return { ...workspace, entities };
}

export function deleteRiskProfile(
  workspace: Workspace,
  entityId: string,
  dashboardId: string,
  profileId: string,
): Workspace {
  const entities = workspace.entities.map(e => {
    if (e.id !== entityId) return e;
    return {
      ...e,
      dashboards: e.dashboards.map(d =>
        d.id === dashboardId
          ? { ...d, riskProfiles: d.riskProfiles.filter(p => p.id !== profileId) }
          : d,
      ),
    };
  });
  return { ...workspace, entities };
}

/** Group FX unlocks when every included subsidiary has a dashboard + FX profile. */
export function groupFxUnlocked(workspace: Workspace): boolean {
  const g = workspace.group;
  if (!g || g.includedEntityIds.length === 0) return false;
  return g.includedEntityIds.every(id => {
    const e = workspace.entities.find(x => x.id === id);
    return e ? entityHasFxSetup(e) : false;
  });
}
