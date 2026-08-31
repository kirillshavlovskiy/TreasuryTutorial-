import {
  INITIAL_ROWS,
  INITIAL_USD_PARAMS,
  makeSimRow,
  type RowState,
  type UsdParams,
} from '@/lib/fx-buffer';
import type { Entity } from '@/lib/workspace-store';
import {
  DEFAULT_FORECAST_PROFILE,
  EMPTY_FORECAST_EXTRAS,
  forecastProfileWithStoreReceivables,
  type ForecastCashExtras,
  type ForecastFlowField,
  type ForecastProfileState,
} from '@/lib/forecast-profile';

export interface EntitySimSeed {
  rows: RowState[];
  usdCash: number;
  usdNonLpCash: number;
  usdParams: UsdParams;
  /** Currencies to show in the FX table for this entity. */
  currencyFilter: string[];
  /** Suggested FX profile currencies (same as filter). */
  profileCurrencies: string[];
  /**
   * Default company cash / FX / liquidity forecast (store AR collections,
   * debt after Tf). Applied when the dashboard has no saved profile yet.
   */
  forecastProfile?: ForecastProfileState;
}

/**
 * Build the simulator book for a dashboard's selected currencies.
 *
 * Entity seed rows win so their real opening balances are preserved. A
 * selected currency missing from the entity seed is materialized from the
 * simulator defaults; unknown currencies get an empty row. USD is omitted
 * because the simulator keeps it in the dedicated USD book.
 */
export function rowsForSelectedCurrencies(
  seedRows: readonly RowState[],
  selectedCurrencies: readonly string[],
): RowState[] {
  const selected = [
    ...new Set(
      selectedCurrencies
        .map(ccy => ccy.trim().toUpperCase())
        .filter(ccy => ccy.length > 0 && ccy !== 'USD'),
    ),
  ];
  const seedByCcy = new Map(seedRows.map(row => [row.ccy.toUpperCase(), row]));
  const defaultsByCcy = new Map(
    INITIAL_ROWS.map(row => [row.ccy.toUpperCase(), row]),
  );

  return selected.map(ccy => {
    const source = seedByCcy.get(ccy) ?? defaultsByCcy.get(ccy);
    return source
      ? { ...source }
      : makeSimRow(`selected-${ccy.toLowerCase()}`, ccy, 0, 0, 0, 0, 0);
  });
}

/** Resolve display name / base currency — tolerates legacy TestEntity fields. */
function entityIdentity(entity: Entity | Record<string, unknown>): {
  name: string;
  base: string;
} {
  const e = entity as Record<string, unknown>;
  const nameRaw =
    (typeof e.name === 'string' && e.name) ||
    (typeof e.legalName === 'string' && e.legalName) ||
    '';
  const baseRaw =
    (typeof e.baseCurrency === 'string' && e.baseCurrency) ||
    (typeof e.functionalCurrency === 'string' && e.functionalCurrency) ||
    '';
  return { name: nameRaw.toLowerCase(), base: baseRaw.toUpperCase() };
}

/**
 * FX Inputs required on each entity's FX profile for Task 01 (FX-only book).
 *
 * | NordTech item       | Table section / column     | FX Input   |
 * |---------------------|----------------------------|------------|
 * | Frankfurt cash      | FX Risk → Cash FX          | fxExposure |
 * | EU receivables      | FX Risk → Non-cash Asset   | fxExposure |
 * | PL payroll accrual  | FX Risk → Liability (FCY)  | fxExposure |
 *
 * Liquidity / rates / IR / swap stay off.
 * Presetup layers: Decision = Hedging; Analytical = Risk Metrics (VaR).
 * Episode stock / Net FX for scoring: EUR Cash FX + receivables − debt = 4.9 − 3 = +1.9.
 */
export const TASK01_REQUIRED_FX_INPUTS = ['fxExposure'] as const;

export const TASK01_REQUIRED_DECISION_LAYERS = ['hedging'] as const;

export const TASK01_REQUIRED_ANALYTICAL_LAYERS = ['riskMetrics'] as const;

/** Task 02 Cash Carry book — six FX exposures, same three legal entities. */
export const TASK02_CARRY_CCYS = ['EUR', 'GBP', 'PLN', 'MXN', 'JPY', 'TRY'] as const;

export const TASK02_FORECAST_MONTHS = 12;

export const TASK02_REQUIRED_FX_INPUTS = TASK01_REQUIRED_FX_INPUTS;
export const TASK02_REQUIRED_DECISION_LAYERS = TASK01_REQUIRED_DECISION_LAYERS;
export const TASK02_REQUIRED_ANALYTICAL_LAYERS = TASK01_REQUIRED_ANALYTICAL_LAYERS;

export function isTask02(taskId?: string | null): boolean {
  return taskId === '02';
}

function extras(partial: Partial<ForecastCashExtras>): ForecastCashExtras {
  return { ...EMPTY_FORECAST_EXTRAS, ...partial };
}

/**
 * Task 02 company forecast — every exposure has profit, spend, NWC and
 * (where the story needs it) debt. MoM growth on NWC / revenue / opex so
 * Analytics and the overlay frontier see a growing long-high / short-low book.
 *
 *   MXN  EARN vs USD (6.19%) — LatAm cash + NWC build (overlay long)
 *   TRY  strong EARN (near-uncorrelated with the rest) — Turkey cash + NWC build (overlay long)
 *   GBP  slight EARN (3.57%) — UK ops
 *   PLN  near-USD (3.41%) — payroll short + PL billing
 *   EUR  PAY (1.78%) — ops pile + AR collect + debt amortize
 *   JPY  PAY (0.45%) — Asia OD + supplier spend / debt (overlay short)
 */
export function task02ForecastProfile(): ForecastProfileState {
  return {
    ...DEFAULT_FORECAST_PROFILE,
    extrasByCcy: {
      EUR: extras({ nwcIn: 0.25, nwcOut: -0.12, debtOut: -0.15 }),
      GBP: extras({ nwcIn: 0.08, nwcOut: -0.05 }),
      PLN: extras({ nwcIn: 0.18, nwcOut: -0.10 }),
      MXN: extras({ nwcIn: 2.8, nwcOut: -1.1, debtOut: -0.9 }),
      JPY: extras({ nwcIn: 12, nwcOut: -22, debtOut: -28 }),
      TRY: extras({ nwcIn: 2.2, nwcOut: -0.85, debtOut: -0.6 }),
    },
    flatGrowthByCcy: {
      EUR: { collections: 0.025, nwcIn: 0.02, payout: 0.015 },
      GBP: { collections: 0.015, nwcIn: 0.01 },
      PLN: { collections: 0.02, nwcIn: 0.03 },
      MXN: { collections: 0.04, nwcIn: 0.035, payout: 0.02 },
      JPY: { payout: 0.02, nwcOut: 0.025, debtOut: 0.015 },
      TRY: { collections: 0.045, nwcIn: 0.04, payout: 0.025 },
    },
  };
}

/** Entity-scoped slice so each legal-entity seed only ships its own CCYs. */
export function task02ForecastFor(
  currencies: readonly string[],
): ForecastProfileState {
  const full = task02ForecastProfile();
  const extrasByCcy: Record<string, ForecastCashExtras> = {};
  const flatGrowthByCcy: Record<string, Partial<Record<ForecastFlowField, number>>> = {};
  for (const ccy of currencies) {
    const key = ccy.trim().toUpperCase();
    const ex = full.extrasByCcy[key];
    if (ex) extrasByCcy[key] = ex;
    const growth = full.flatGrowthByCcy?.[key];
    if (growth) flatGrowthByCcy[key] = growth;
  }
  return { ...DEFAULT_FORECAST_PROFILE, extrasByCcy, flatGrowthByCcy };
}

export function simSeedForEntity(entity: Entity, taskId?: string): EntitySimSeed {
  const { name, base } = entityIdentity(entity);

  if (name.includes('poland') || name.includes('krak') || base === 'PLN') {
    // Payroll short; Task 02 adds PL billing profit so NWC / carry have a path.
    const pln = makeSimRow(
      'pl-1',
      'PLN',
      0,
      0,
      0,
      0,
      -1.8,
      isTask02(taskId) ? 0.55 : 0,
      0,
    );
    pln.nonCash = -1.8;
    return {
      rows: [pln],
      usdCash: 0,
      usdNonLpCash: 0,
      usdParams: { ...INITIAL_USD_PARAMS },
      currencyFilter: ['PLN'],
      profileCurrencies: ['PLN'],
      forecastProfile: isTask02(taskId) ? task02ForecastFor(['PLN']) : undefined,
    };
  }

  if (
    name.includes('gmbh') ||
    name.includes('frankfurt') ||
    name.includes('germany') ||
    base === 'EUR'
  ) {
    // Cash FX (spot) + receivables − venture debt → Net FX / Exp stock = 1.9.
    // Store AR collects 0.2/month over the 12-month cash / FX / liquidity
    // forecast; venture debt is repaid after that projection.
    const eur = makeSimRow(
      'de-1',
      'EUR',
      2.5,
      0,
      0,
      2.5,
      isTask02(taskId) ? -0.45 : 0,
      1.2,
      0,
    );
    eur.nonCashAsset = 2.4; // EU receivables (FX Risk → Non-cash Asset)
    eur.ir_liab_notional = 3.0; // venture debt (FX POSITION → Debt)
    eur.ir_liab_rate = 0;
    // UK reseller stake = equity investment asset in GBP (not a USD liability).
    const gbp = makeSimRow(
      'de-2',
      'GBP',
      isTask02(taskId) ? 2.0 : 0,
      0,
      0,
      isTask02(taskId) ? 2.0 : 0,
      isTask02(taskId) ? -0.20 : 0,
      isTask02(taskId) ? 0.35 : 0,
      0,
    );
    gbp.ir_invest_notional = 0.5;
    gbp.ir_invest_rate = 0;
    // Task 02: JPY Asia supplier OD — low-yield PAY book the overlay shorts.
    const jpy = makeSimRow('de-jpy', 'JPY', -900, 0, 0, -900, -55, 25, 0);
    return {
      rows: isTask02(taskId) ? [eur, gbp, jpy] : [eur, gbp],
      usdCash: 0,
      usdNonLpCash: 0,
      usdParams: { ...INITIAL_USD_PARAMS },
      currencyFilter: isTask02(taskId) ? ['EUR', 'GBP', 'JPY'] : ['EUR', 'GBP'],
      profileCurrencies: isTask02(taskId) ? ['EUR', 'GBP', 'JPY'] : ['EUR', 'GBP'],
      forecastProfile: isTask02(taskId)
        ? task02ForecastFor(['EUR', 'GBP', 'JPY'])
        : forecastProfileWithStoreReceivables(['EUR']),
    };
  }

  // Default / NordTech US — USD hub
  // Task 02: MXN LatAm cash — high-yield EARN book the overlay longs.
  const mxn = makeSimRow('us-mxn', 'MXN', 90, 0, 0, 90, -3.2, 5.5, 0);
  // Task 02: TRY Turkey cash — very-high-yield EARN book, near-uncorrelated
  // with the rest of the book (added to test generalization beyond the
  // original 5-currency set).
  const tryRow = makeSimRow('us-try', 'TRY', 60, 0, 0, 60, -2, 3, 0);
  return {
    rows: isTask02(taskId) ? [mxn, tryRow] : [],
    usdCash: 6.0,
    usdNonLpCash: 0,
    usdParams: { ...INITIAL_USD_PARAMS, payout: -0.8, collections: 0 },
    currencyFilter: isTask02(taskId) ? ['MXN', 'TRY'] : [],
    profileCurrencies: isTask02(taskId) ? ['MXN', 'TRY'] : ['USD'],
    forecastProfile: isTask02(taskId) ? task02ForecastFor(['MXN', 'TRY']) : undefined,
  };
}

/** Match seeded NordTech entity names for structure scoring. */
export function classifyNordtechEntity(
  entity: Entity,
): 'US' | 'DE' | 'PL' | null {
  const { name, base } = entityIdentity(entity);
  if (!name && !base) return null;
  if (name.includes('poland') || name.includes('krak') || base === 'PLN') return 'PL';
  if (name.includes('gmbh') || name.includes('frankfurt') || base === 'EUR') return 'DE';
  if (
    name.includes('nordtech us') ||
    name.includes('us hub') ||
    (name.includes('us') && base === 'USD') ||
    (base === 'USD' && !name.includes('gmbh'))
  ) {
    return 'US';
  }
  return null;
}

/** Merge per-entity default cash / FX / liquidity extras for a consolidated desk. */
export function mergedEntityForecastProfile(
  entities: readonly Entity[],
  taskId?: string,
): ForecastProfileState {
  const extrasByCcy: Record<string, ForecastCashExtras> = {};
  const flatGrowthByCcy: Record<string, Partial<Record<ForecastFlowField, number>>> = {};
  for (const e of entities) {
    const fp = simSeedForEntity(e, taskId).forecastProfile;
    if (fp?.extrasByCcy) Object.assign(extrasByCcy, fp.extrasByCcy);
    if (fp?.flatGrowthByCcy) Object.assign(flatGrowthByCcy, fp.flatGrowthByCcy);
  }
  return { ...DEFAULT_FORECAST_PROFILE, extrasByCcy, flatGrowthByCcy };
}
