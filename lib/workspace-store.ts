// Workspace data model + persistence for the entity / dashboard / risk-profile
// workflow. Persistence is client-side (localStorage), scoped per signed-in
// user. This is a prototype layer: the same shape maps cleanly onto a
// PostgreSQL + Sequelize backend (Entity → Dashboard → RiskProfile tables)
// when server persistence is introduced.

import type { LayerId } from '@/lib/fx-buffer';

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
  { id: 'rates',        label: 'Rates',        description: 'NP credit / debit rates and carry differentials.' },
  { id: 'bonds',        label: 'Bonds',        description: 'Fixed-rate instrument notionals in the IR profile.' },
  { id: 'investments',  label: 'Investments',  description: 'Interest-earning asset positions.' },
  { id: 'liabilities',  label: 'Liabilities',  description: 'Funding / overdraft liabilities.' },
];

// Optimization metrics → simulator layers.
export type OptMetric = 'minFloor' | 'payoutBuffer' | 'carryTarget' | 'portfolioVar';

export const OPT_METRICS: { id: OptMetric; label: string; layer: LayerId; description: string }[] = [
  { id: 'minFloor',     label: 'Min Floor',      layer: 'floorH',       description: 'Hard per-currency minimum cash floor.' },
  { id: 'payoutBuffer', label: 'Payout Buffer',  layer: 'sigmaP',       description: 'Forecast-uncertainty (σ_P) safety margin on payouts.' },
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

export interface Dashboard {
  id: string;
  name: string;
  createdAt: string;
  riskProfiles: RiskProfile[];
  timing?: TimingProfile;
  /** Per-cell formula overrides for the FX simulator, keyed `${ccy}::${fieldKey}`. */
  formulas?: Record<string, string>;
}

export interface Entity {
  id: string;
  name: string;
  baseCurrency: string;
  description: string;
  createdAt: string;
  dashboards: Dashboard[];
}

export interface Workspace {
  entities: Entity[];
}

const STORAGE_PREFIX = 'treasury:workspace:';

function storageKey(userKey: string): string {
  return `${STORAGE_PREFIX}${userKey}`;
}

function emptyWorkspace(): Workspace {
  return { entities: [] };
}

/** Read the full workspace for a user. Safe on the server (returns empty). */
export function loadWorkspace(userKey: string): Workspace {
  if (typeof window === 'undefined') return emptyWorkspace();
  try {
    const raw = window.localStorage.getItem(storageKey(userKey));
    if (!raw) return emptyWorkspace();
    const parsed = JSON.parse(raw) as Workspace;
    if (!parsed || !Array.isArray(parsed.entities)) return emptyWorkspace();
    return parsed;
  } catch {
    return emptyWorkspace();
  }
}

export function saveWorkspace(userKey: string, workspace: Workspace): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey(userKey), JSON.stringify(workspace));
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createEntity(
  workspace: Workspace,
  input: { name: string; baseCurrency: string; description?: string },
): { workspace: Workspace; entity: Entity } {
  const entity: Entity = {
    id: makeId('ent'),
    name: input.name.trim(),
    baseCurrency: input.baseCurrency,
    description: input.description?.trim() ?? '',
    createdAt: new Date().toISOString(),
    dashboards: [],
  };
  return { workspace: { entities: [...workspace.entities, entity] }, entity };
}

export function createDashboard(
  workspace: Workspace,
  entityId: string,
  name: string,
): { workspace: Workspace; dashboard: Dashboard } {
  const dashboard: Dashboard = {
    id: makeId('dash'),
    name: name.trim(),
    createdAt: new Date().toISOString(),
    riskProfiles: [],
    timing: DEFAULT_TIMING,
  };
  const entities = workspace.entities.map(e =>
    e.id === entityId ? { ...e, dashboards: [...e.dashboards, dashboard] } : e,
  );
  return { workspace: { entities }, dashboard };
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
  return { workspace: { entities }, profile };
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
  return { entities };
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
  return { entities };
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
  return { entities };
}

export function renameEntity(
  workspace: Workspace,
  entityId: string,
  name: string,
): Workspace {
  const trimmed = name.trim();
  if (!trimmed) return workspace;
  return {
    entities: workspace.entities.map(e =>
      e.id === entityId ? { ...e, name: trimmed } : e,
    ),
  };
}

export function deleteEntity(workspace: Workspace, entityId: string): Workspace {
  return { entities: workspace.entities.filter(e => e.id !== entityId) };
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
  return { entities };
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
  return { entities };
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
  return { entities };
}
