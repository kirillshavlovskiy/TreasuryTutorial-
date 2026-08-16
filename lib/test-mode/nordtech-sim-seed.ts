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
  forecastProfileWithStoreReceivables,
  type ForecastCashExtras,
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

export function simSeedForEntity(entity: Entity): EntitySimSeed {
  const { name, base } = entityIdentity(entity);

  if (name.includes('poland') || name.includes('krak') || base === 'PLN') {
    const pln = makeSimRow('pl-1', 'PLN', 0, 0, 0, 0, -1.8, 0, 0);
    // Payroll accrual as FX liability short (and monthly payout flow).
    pln.nonCash = -1.8;
    return {
      rows: [pln],
      usdCash: 0,
      usdNonLpCash: 0,
      usdParams: { ...INITIAL_USD_PARAMS },
      currencyFilter: ['PLN'],
      profileCurrencies: ['PLN'],
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
    const eur = makeSimRow('de-1', 'EUR', 2.5, 0, 0, 2.5, 0, 1.2, 0);
    eur.nonCashAsset = 2.4; // EU receivables (FX Risk → Non-cash Asset)
    eur.ir_liab_notional = 3.0; // venture debt (FX POSITION → Debt)
    eur.ir_liab_rate = 0;
    // UK reseller stake = equity investment asset in GBP (not a USD liability).
    const gbp = makeSimRow('de-2', 'GBP', 0, 0, 0, 0, 0, 0, 0);
    gbp.ir_invest_notional = 0.5;
    gbp.ir_invest_rate = 0;
    return {
      rows: [eur, gbp],
      usdCash: 0,
      usdNonLpCash: 0,
      usdParams: { ...INITIAL_USD_PARAMS },
      currencyFilter: ['EUR', 'GBP'],
      profileCurrencies: ['EUR', 'GBP'],
      // Store AR 0.2/month × 12m into cash + FX + liquidity; debt repaid after Tf.
      forecastProfile: forecastProfileWithStoreReceivables(['EUR']),
    };
  }

  // Default / NordTech US — USD hub
  return {
    rows: [],
    usdCash: 6.0,
    usdNonLpCash: 0,
    usdParams: { ...INITIAL_USD_PARAMS, payout: -0.8, collections: 0 },
    currencyFilter: [], // USD-only book (no FCY rows)
    profileCurrencies: ['USD'],
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
): ForecastProfileState {
  const extrasByCcy: Record<string, ForecastCashExtras> = {};
  for (const e of entities) {
    const extras = simSeedForEntity(e).forecastProfile?.extrasByCcy;
    if (!extras) continue;
    Object.assign(extrasByCcy, extras);
  }
  return { ...DEFAULT_FORECAST_PROFILE, extrasByCcy };
}
