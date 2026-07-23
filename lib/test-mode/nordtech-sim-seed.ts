import { makeSimRow, INITIAL_USD_PARAMS, type RowState, type UsdParams } from '@/lib/fx-buffer';
import type { Entity } from '@/lib/workspace-store';

export interface EntitySimSeed {
  rows: RowState[];
  usdCash: number;
  usdNonNpCash: number;
  usdParams: UsdParams;
  /** Currencies to show in the FX table for this entity. */
  currencyFilter: string[];
  /** Suggested FX profile currencies (same as filter). */
  profileCurrencies: string[];
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
 * Episode stock mismatch for scoring: EUR Cash FX + receivables = +4.9.
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
      usdNonNpCash: 0,
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
    // Cash FX (spot) carries the Frankfurt cash so the FX-only book still shows +4.9.
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
      usdNonNpCash: 0,
      usdParams: { ...INITIAL_USD_PARAMS },
      currencyFilter: ['EUR', 'GBP'],
      profileCurrencies: ['EUR', 'GBP'],
    };
  }

  // Default / NordTech US — USD hub
  return {
    rows: [],
    usdCash: 6.0,
    usdNonNpCash: 0,
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
