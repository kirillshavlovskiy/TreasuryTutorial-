// Workspace data model + persistence for the entity / dashboard / risk-profile
// workflow. Persistence is client-side (localStorage), scoped per signed-in
// user. This is a prototype layer: the same shape maps cleanly onto a
// PostgreSQL + Sequelize backend (Entity → Dashboard → RiskProfile tables)
// when server persistence is introduced.

import { INITIAL_ROWS, type LayerId } from '@/lib/fx-buffer';
import type { ForecastProfileState } from '@/lib/forecast-profile';
import {
  hedgeSidecarStorageKey,
  mergeHedgesWithSidecar,
  normalizeHedgeBooksMap,
  parseHedgeSidecar,
  pickHedgeBooksForWrite,
  rebindHedgeBooksToWorkspace,
  serializeHedgeSidecar,
} from '@/lib/hedge-book-normalize';
import { migrateFormulaOverrides } from '@/lib/sim-formulas';
import type { EntityHedgeBook } from '@/lib/test-mode/hedge-var';
import type { VarSetup } from '@/lib/test-mode/var-setup';

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
  { id: 'cfarCover',    label: 'CFaR Cover',     layer: 'cfarCover',    description: 'FX-hedge Net CFaR readout (USD P&L). Does not size the funding swap — payout-σ does.' },
  { id: 'carryTarget',  label: 'Buffer Carry Target',   layer: 'carryOptim',   description: 'Steer Target LP Cash so Buffer Carry (funding-swap cash Δr vs USD) hits the ask.' },
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

/** Single risk metric the desk protects. Liquidity is always on, not a pick. */
export type ProtectGoalId = 'var' | 'cfar' | 'ear' | 'evar';

/** What the desk optimises. Risk metric (Protect) and Liquidity stay on. */
export type OptimizeFrameworkId = 'hedgeRatio' | 'carryCashInterest' | 'greeksSensitivity';

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

export const PROTECT_GOALS: {
  id: ProtectGoalId;
  label: string;
  longLabel: string;
  live: boolean;
}[] = [
  { id: 'var', label: 'VaR', longLabel: 'Value at Risk', live: true },
  { id: 'cfar', label: 'CFaR', longLabel: 'Cash Flow at Risk', live: true },
  { id: 'ear', label: 'EaR', longLabel: 'Earnings at Risk', live: false },
  { id: 'evar', label: 'EVaR', longLabel: 'Economic Value at Risk', live: false },
];

export const OPTIMIZE_FRAMEWORKS: {
  id: OptimizeFrameworkId;
  /** Short form for the wizard's narrow select cards. */
  label: string;
  /** Spelled out — what desk summaries show. */
  longLabel: string;
  live: boolean;
  /** When set, only offer for this risk asset (else all). */
  assets?: RiskAssetId[];
}[] = [
  {
    id: 'hedgeRatio',
    label: 'Hedge ratio',
    longLabel: 'Hedge ratio',
    live: true,
  },
  {
    id: 'carryCashInterest',
    label: 'Carry & cash interest',
    longLabel: 'Carry & cash interest',
    live: true,
  },
  {
    id: 'greeksSensitivity',
    label: 'Greeks / Sensitivity hedging',
    longLabel: 'Greeks / Sensitivity hedging',
    live: true,
    assets: ['currencies'],
  },
];

/** Full FX universe the desk can scope — same book as the simulator grid. */
export const FX_CURRENCY_UNIVERSE: string[] = INITIAL_ROWS.map(r => r.ccy);

/** Default LP subset when an entity has not configured its own pool. */
export const DEFAULT_LP_CURRENCIES: string[] = [
  'EUR', 'GBP', 'JPY', 'PLN', 'CHF', 'CAD', 'AUD',
  'SEK', 'NOK', 'DKK', 'CZK', 'HUF', 'MXN', 'ZAR',
].filter(c => FX_CURRENCY_UNIVERSE.includes(c));

export function entityAllCurrencies(entity: Pick<Entity, 'allCurrencies'>): string[] {
  if (entity.allCurrencies && entity.allCurrencies.length > 0) {
    return [...entity.allCurrencies];
  }
  return [...FX_CURRENCY_UNIVERSE];
}

export function entityLpCurrencies(
  entity: Pick<Entity, 'allCurrencies' | 'lpCurrencies'>,
): string[] {
  const all = new Set(entityAllCurrencies(entity));
  const lp = entity.lpCurrencies?.length ? entity.lpCurrencies : DEFAULT_LP_CURRENCIES;
  return lp.filter(c => all.has(c));
}

/** Map stored / legacy protect ids onto the single current risk metric. */
export function normalizeProtect(ids: readonly string[] | undefined): ProtectGoalId[] {
  const order = PROTECT_GOALS.map(g => g.id);
  for (const id of ids ?? []) {
    const mapped =
      id === 'var' || id === 'assetValue' ? 'var'
      : id === 'cfar' || id === 'cashFlow' ? 'cfar'
      : id === 'ear' || id === 'earnings' ? 'ear'
      : id === 'evar' || id === 'credit' ? 'evar'
      : null;
    if (mapped && order.includes(mapped)) return [mapped];
  }
  return ['var'];
}

/** Map stored / legacy optimize ids onto hedge ratio, carry, and Greeks. */
export function normalizeOptimize(ids: readonly string[] | undefined): OptimizeFrameworkId[] {
  const out = new Set<OptimizeFrameworkId>();
  for (const id of ids ?? []) {
    if (id === 'hedgeRatio') out.add('hedgeRatio');
    if (id === 'greeks' || id === 'greeksSensitivity' || id === 'sensitivity') {
      out.add('greeksSensitivity');
    }
    if (id === 'carryCashInterest') out.add('carryCashInterest');
    if (id === 'hedgeCarry') {
      out.add('hedgeRatio');
      out.add('carryCashInterest');
    }
  }
  if (out.size === 0) {
    out.add('hedgeRatio');
    out.add('carryCashInterest');
  }
  return OPTIMIZE_FRAMEWORKS.map(f => f.id).filter(id => out.has(id));
}

export function normalizeDashboardSetup(setup: DashboardSetup): DashboardSetup {
  return {
    ...setup,
    protect: normalizeProtect(setup.protect),
    optimize: normalizeOptimize(setup.optimize),
    tickers: [...setup.tickers],
    instruments: setup.instruments?.map(i => ({ ...i })),
  };
}

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
  /** Full currency universe this entity can put on a desk. */
  allCurrencies?: string[];
  /** Subset held in the liquidity pool — Select LP on the ticker step. */
  lpCurrencies?: string[];
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
  allCurrencies?: string[];
  lpCurrencies?: string[];
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
    const setup = sub.setup ? normalizeDashboardSetup(sub.setup) : sub.setup;
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
      allCurrencies: sub.allCurrencies,
      lpCurrencies: sub.lpCurrencies,
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
/** v2: envelope with hedge books + VaR setup. v1 was the bare Workspace object. */
export const WORKSPACE_BLOB_VERSION = 2;

function storageKey(userKey: string): string {
  return `${STORAGE_PREFIX}${userKey}`;
}

export function emptyWorkspace(): Workspace {
  return { entities: [] };
}

export interface WorkspaceLoadResult {
  workspace: Workspace;
  hedgesByEntityId: Record<string, EntityHedgeBook>;
  varSetup?: VarSetup;
  updatedAt?: string;
  hedgesUpdatedAt?: string;
  /** True when localStorage was unreadable / corrupt and we fell back to empty. */
  loadWarning?: string;
}

export interface WorkspaceSaveExtras {
  hedgesByEntityId?: Record<string, EntityHedgeBook>;
  varSetup?: VarSetup;
  hedgesUpdatedAt?: string;
}

export interface WorkspaceSaveResult {
  ok: boolean;
  error?: string;
}

interface WorkspacePersistBlob {
  version?: number;
  workspace?: Workspace;
  entities?: Workspace['entities'];
  group?: Workspace['group'];
  hedgesByEntityId?: unknown;
  varSetup?: unknown;
  updatedAt?: string;
  hedgesUpdatedAt?: string;
}

function emptyLoadResult(loadWarning?: string): WorkspaceLoadResult {
  return {
    workspace: emptyWorkspace(),
    hedgesByEntityId: {},
    ...(loadWarning ? { loadWarning } : {}),
  };
}

function isBareWorkspace(parsed: unknown): parsed is Workspace {
  if (!parsed || typeof parsed !== 'object') return false;
  const row = parsed as WorkspacePersistBlob;
  return Array.isArray(row.entities) && row.workspace == null;
}

function parseWorkspaceBlob(parsed: unknown): WorkspaceLoadResult | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const blob = parsed as WorkspacePersistBlob;
  if (isBareWorkspace(blob)) {
    return {
      workspace: hydrateWorkspace(migrateRenamedFormulaRefs(blob)),
      hedgesByEntityId: {},
    };
  }
  if (!blob.workspace || !Array.isArray(blob.workspace.entities)) return null;
  const varSetup =
    blob.varSetup && typeof blob.varSetup === 'object'
      ? (blob.varSetup as VarSetup)
      : undefined;
  return {
    workspace: hydrateWorkspace(migrateRenamedFormulaRefs(blob.workspace)),
    hedgesByEntityId: normalizeHedgeBooksMap(blob.hedgesByEntityId),
    ...(varSetup ? { varSetup } : {}),
    ...(blob.updatedAt ? { updatedAt: blob.updatedAt } : {}),
    ...(typeof blob.hedgesUpdatedAt === 'string'
      ? { hedgesUpdatedAt: blob.hedgesUpdatedAt }
      : {}),
  };
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

function readWorkspaceHedgeSidecar(userKey: string) {
  if (typeof window === 'undefined') return null;
  try {
    return parseHedgeSidecar(
      window.localStorage.getItem(hedgeSidecarStorageKey(storageKey(userKey))),
    );
  } catch {
    return null;
  }
}

function withWorkspaceSidecar(
  book: WorkspaceLoadResult,
  userKey: string,
): WorkspaceLoadResult {
  const picked = mergeHedgesWithSidecar(
    book.hedgesByEntityId,
    book.hedgesUpdatedAt,
    readWorkspaceHedgeSidecar(userKey),
  );
  return {
    ...book,
    hedgesByEntityId: rebindHedgeBooksToWorkspace(
      picked.hedgesByEntityId,
      book.workspace.entities,
    ),
    hedgesUpdatedAt: picked.hedgesUpdatedAt,
  };
}

/** Load with an optional warning when storage is corrupt or unavailable. */
export function loadWorkspaceDetailed(userKey: string): WorkspaceLoadResult {
  if (typeof window === 'undefined') return emptyLoadResult();
  try {
    const raw = window.localStorage.getItem(storageKey(userKey));
    if (!raw) return withWorkspaceSidecar(emptyLoadResult(), userKey);
    const parsed: unknown = JSON.parse(raw);
    const book = parseWorkspaceBlob(parsed);
    if (!book) {
      return withWorkspaceSidecar(
        emptyLoadResult(
          'Saved workspace was unreadable — started with an empty book.',
        ),
        userKey,
      );
    }
    return withWorkspaceSidecar(book, userKey);
  } catch {
    return withWorkspaceSidecar(
      emptyLoadResult(
        'Could not read workspace from browser storage — started empty.',
      ),
      userKey,
    );
  }
}

/** Persist workspace to localStorage. Returns ok/error instead of throwing. */
export function saveWorkspace(
  userKey: string,
  workspace: Workspace,
  extras?: WorkspaceSaveExtras,
): WorkspaceSaveResult {
  if (typeof window === 'undefined') {
    return { ok: false, error: 'Workspace save is only available in the browser.' };
  }
  try {
    const prev = loadWorkspaceDetailed(userKey);
    const incomingHedges = extras?.hedgesByEntityId;
    const picked =
      incomingHedges === undefined
        ? {
            hedgesByEntityId: prev.hedgesByEntityId ?? {},
            hedgesUpdatedAt: extras?.hedgesUpdatedAt ?? prev.hedgesUpdatedAt,
          }
        : pickHedgeBooksForWrite(
            incomingHedges,
            prev.hedgesByEntityId,
            extras?.hedgesUpdatedAt,
            prev.hedgesUpdatedAt,
          );
    const blob: WorkspacePersistBlob = {
      version: WORKSPACE_BLOB_VERSION,
      workspace,
      hedgesByEntityId: picked.hedgesByEntityId,
      varSetup: extras?.varSetup ?? prev.varSetup,
      updatedAt: new Date().toISOString(),
      hedgesUpdatedAt: picked.hedgesUpdatedAt,
    };
    try {
      window.localStorage.setItem(
        hedgeSidecarStorageKey(storageKey(userKey)),
        serializeHedgeSidecar(picked.hedgesByEntityId, blob.hedgesUpdatedAt),
      );
    } catch {
      // Quota — still try the full envelope / Neon PUT.
    }
    window.localStorage.setItem(storageKey(userKey), JSON.stringify(blob));
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
    allCurrencies?: string[];
    lpCurrencies?: string[];
  },
): { workspace: Workspace; entity: Entity } {
  const allCurrencies = input.allCurrencies?.length
    ? [...input.allCurrencies]
    : [...FX_CURRENCY_UNIVERSE];
  const allSet = new Set(allCurrencies);
  const lpCurrencies = (input.lpCurrencies?.length ? input.lpCurrencies : DEFAULT_LP_CURRENCIES)
    .filter(c => allSet.has(c));
  const entity: Entity = {
    id: makeId('ent'),
    name: input.name.trim(),
    baseCurrency: input.baseCurrency,
    description: input.description?.trim() ?? '',
    createdAt: new Date().toISOString(),
    dashboards: [],
    riskAssets: input.riskAssets,
    allCurrencies,
    lpCurrencies,
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
  const protect = normalizeProtect(setup.protect)[0] ?? 'var';
  const optimize = normalizeOptimize(setup.optimize);

  const inputs: FxInput[] = ['fxExposure', 'liquidity'];
  if (optimize.includes('hedgeRatio') || optimize.includes('carryCashInterest')) {
    if (!inputs.includes('rates')) inputs.push('rates');
  }

  const optimizationMetrics: OptMetric[] = ['minFloor', 'payoutBuffer'];
  if (protect === 'var' || protect === 'evar') {
    optimizationMetrics.push('portfolioVar');
  }
  if (protect === 'cfar') {
    optimizationMetrics.push('cfarCover');
  }
  if (protect === 'ear') {
    optimizationMetrics.push('portfolioVar');
  }
  if (optimize.includes('carryCashInterest')) {
    optimizationMetrics.push('carryTarget');
  }
  if (optimizationMetrics.length === 0) {
    optimizationMetrics.push(...defaultCurriculumFxConfig().optimizationMetrics);
  }

  const decisionLayers: DecisionLayer[] = optimize.includes('hedgeRatio') ? ['hedging'] : [];
  const analyticalLayers: AnalyticalLayer[] = ['riskMetrics'];
  if (optimize.includes('greeksSensitivity')) {
    analyticalLayers.push('sensitivity');
  }

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
  const setup = normalizeDashboardSetup(input.setup);
  const created = createDashboard(workspace, entityId, name, setup);

  const profileInput =
    setup.riskAsset === 'currencies'
      ? {
          type: 'fx' as const,
          name: 'Cash/FX',
          fxConfig: fxConfigFromDashboardSetup(setup),
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
  if (dashboard.setup) return normalizeDashboardSetup(dashboard.setup);

  const fx = dashboard.riskProfiles.find(p => p.type === 'fx')?.fxConfig;
  if (fx) {
    const protect: ProtectGoalId[] = fx.optimizationMetrics.includes('cfarCover')
      ? ['cfar']
      : ['var'];
    const optimize: OptimizeFrameworkId[] = [];
    if ((fx.decisionLayers ?? []).includes('hedging')) optimize.push('hedgeRatio');
    if (fx.optimizationMetrics.includes('carryTarget')) optimize.push('carryCashInterest');
    if ((fx.analyticalLayers ?? []).includes('sensitivity')) {
      optimize.push('greeksSensitivity');
    }

    return normalizeDashboardSetup({
      riskAsset: 'currencies',
      protect,
      optimize,
      tickers:
        fx.currencyMode === 'selected' && fx.currencies.length > 0
          ? [...fx.currencies]
          : ['EUR', 'GBP', 'JPY'],
    });
  }

  const primary = dashboard.riskProfiles[0]?.type;
  const asset =
    RISK_ASSETS.find(a => a.profileType === primary && a.id !== 'currencies')
    ?? RISK_ASSETS.find(a => a.profileType === primary)
    ?? RISK_ASSETS[0];
  return {
    riskAsset: asset.id,
    protect: ['var'],
    optimize: ['hedgeRatio', 'carryCashInterest'],
    tickers: [],
  };
}

export function hydrateEntity(entity: Entity): Entity {
  const dashboards = entity.dashboards.map(d =>
    d.setup ? { ...d, setup: normalizeDashboardSetup(d.setup) } : d,
  );
  return {
    ...entity,
    allCurrencies: entityAllCurrencies(entity),
    lpCurrencies: entityLpCurrencies(entity),
    dashboards,
  };
}

export function hydrateWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    entities: workspace.entities.map(hydrateEntity),
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
  const setup = normalizeDashboardSetup(input.setup);

  const profile: RiskProfile =
    setup.riskAsset === 'currencies'
      ? {
          id: makeId('rp'),
          type: 'fx',
          name: 'Cash/FX',
          createdAt: new Date().toISOString(),
          fxConfig: fxConfigFromDashboardSetup(setup),
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
          setup,
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
  return updateEntity(workspace, entityId, { name });
}

export function updateEntity(
  workspace: Workspace,
  entityId: string,
  patch: {
    name?: string;
    allCurrencies?: string[];
    lpCurrencies?: string[];
  },
): Workspace {
  return {
    ...workspace,
    entities: workspace.entities.map(e => {
      if (e.id !== entityId) return e;
      const name = patch.name?.trim();
      const allCurrencies = patch.allCurrencies
        ? [...patch.allCurrencies]
        : e.allCurrencies;
      const allSet = new Set(allCurrencies ?? entityAllCurrencies(e));
      const lpCurrencies = (patch.lpCurrencies ?? e.lpCurrencies ?? [])
        .filter(c => allSet.has(c));
      return {
        ...e,
        ...(name ? { name } : {}),
        ...(allCurrencies ? { allCurrencies } : {}),
        lpCurrencies,
      };
    }),
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
