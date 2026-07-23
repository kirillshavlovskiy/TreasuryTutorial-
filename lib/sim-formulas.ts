// Editable simulator fields and their DEFAULT formulas (named references).
//
// Each calculated field the user can edit has a default formula that reproduces
// the current model calculation. Users may override any field with their own
// Excel-like expression referencing other named fields (see AVAILABLE_REFS).
// Fields are resolved in array order, so a later field may reference an
// earlier field's resolved (possibly overridden) value — like a spreadsheet.

import { safeEval, type Scope } from './formula';

export type SimSection = 'liquidity' | 'carry' | 'swap' | 'hedge';

export type SimFieldKey =
  | 'troughCash' | 'cycleNetFlow' | 'totalCash' | 'totalCashUSD'
  | 'targetNpCash' | 'targetNpCashUSD'
  | 'swapNear' | 'swapUSD' | 'npSwap' | 'npSwapUSD' | 'cycleEnd' | 'cycleEndUSD'
  | 'fwdHedgeUSD' | 'optionHedgeUSD';

export interface SimFieldDef {
  key: SimFieldKey;
  label: string;
  section: SimSection;
  /**
   * Default formula in named refs. Empty string means "use the model value
   * already present in the base scope under `key`" (e.g. optimiser-derived
   * swap notional that has no closed-form expression).
   */
  defaultFormula: string;
}

// Resolution order == dependency order (a field may reference earlier ones).
export const SIM_FIELDS: SimFieldDef[] = [
  { key: 'troughCash',    label: 'Trough Cash',        section: 'liquidity', defaultFormula: 'cash + payout' },
  { key: 'totalCash',     label: 'Total Cash',         section: 'liquidity', defaultFormula: 'cash + nonNpCash' },
  { key: 'cycleNetFlow',  label: 'Cycle Net Flow',     section: 'liquidity', defaultFormula: 'totalCash + payout + collections' },
  { key: 'totalCashUSD',  label: 'Total Cash $USD',    section: 'liquidity', defaultFormula: 'totalCash * spotRate' },
  { key: 'swapNear',      label: 'Swap Near',          section: 'swap',      defaultFormula: '' },
  { key: 'targetNpCash',  label: 'Target NP Cash',     section: 'carry',     defaultFormula: 'cash + swapNear' },
  { key: 'targetNpCashUSD', label: 'Target NP Cash $USD', section: 'carry',  defaultFormula: 'targetNpCash * spotRate' },
  { key: 'swapUSD',       label: 'Swap $USD',          section: 'swap',      defaultFormula: 'swapNear * spotRate' },
  { key: 'npSwap',        label: 'NP+Swap',            section: 'swap',      defaultFormula: 'cash + swapNear' },
  { key: 'npSwapUSD',     label: 'NP+Swap $USD',       section: 'swap',      defaultFormula: 'npSwap * spotRate' },
  { key: 'cycleEnd',      label: 'Cycle End',          section: 'swap',      defaultFormula: 'npSwap + payout + collections + fcastFX + nonNpCash' },
  { key: 'cycleEndUSD',   label: 'Cycle End $USD',     section: 'swap',      defaultFormula: 'cycleEnd * spotRate' },
  { key: 'fwdHedgeUSD',   label: 'Fwd Hedge $USD',     section: 'hedge',     defaultFormula: 'fwdNotional * spotRate' },
  { key: 'optionHedgeUSD', label: 'Option Hedge $USD', section: 'hedge',     defaultFormula: 'optNotional * optDelta * spotRate' },
];

export const SIM_FIELD_BY_KEY: Record<SimFieldKey, SimFieldDef> =
  Object.fromEntries(SIM_FIELDS.map(f => [f.key, f])) as Record<SimFieldKey, SimFieldDef>;

/** Named references a user may use in a formula (row inputs + computed values). */
export const AVAILABLE_REFS: { name: string; desc: string }[] = [
  { name: 'cash',           desc: 'Opening NP cash (M FCY)' },
  { name: 'payout',         desc: 'Gross payouts (M FCY, negative = outflow)' },
  { name: 'collections',    desc: 'Gross payins (M FCY)' },
  { name: 'nonNpCash',      desc: 'Non-NP cash (M FCY)' },
  { name: 'fcastFX',        desc: 'Forecast invoice FX (M FCY)' },
  { name: 'spot',           desc: 'TMS FX spot exposure (M FCY)' },
  { name: 'fwd',            desc: 'Outstanding fwd settlement (M USD)' },
  { name: 'nonCash',        desc: 'Non-cash liability BS FX (M FCY)' },
  { name: 'nonCashAsset',   desc: 'Non-cash asset FX exposure (M FCY)' },
  { name: 'rFCY',           desc: 'FCY credit rate (% p.a.)' },
  { name: 'rOD',            desc: 'FCY debit rate (% p.a.)' },
  { name: 'rUSD',           desc: 'USD deposit rate (% p.a.)' },
  { name: 'spotRate',       desc: 'USD per 1 FCY' },
  { name: 'netFxFCY',       desc: 'Net FX book (M FCY)' },
  { name: 'netFxForecast',  desc: 'Cycle-end net FX forecast (M FCY)' },
  { name: 'fwdNotional',    desc: 'Model forward notional (M FCY)' },
  { name: 'optNotional',    desc: 'Model option notional (M FCY)' },
  { name: 'optDelta',       desc: 'Option delta' },
  { name: 'troughCash',     desc: 'Trough cash (resolved)' },
  { name: 'totalCash',      desc: 'Total cash (resolved)' },
  { name: 'swapNear',       desc: 'Swap near leg (resolved)' },
  { name: 'targetNpCash',   desc: 'Target NP cash (resolved)' },
  { name: 'npSwap',         desc: 'NP + swap (resolved)' },
  { name: 'cycleEnd',       desc: 'Cycle end cash (resolved)' },
];

export interface ResolvedRow {
  /** Resolved numeric value per editable field key. */
  values: Record<SimFieldKey, number>;
  /** Parse/eval error message per field key (only present on failure). */
  errors: Partial<Record<SimFieldKey, string>>;
  /** Full scope after resolution (base refs + resolved field values). */
  scope: Scope;
}

/**
 * Resolve every editable field for one row. `overrides[key]` (when a non-empty
 * string) replaces the default formula. Fields are evaluated in SIM_FIELDS
 * order and written back into the scope so later fields see earlier results.
 */
export function resolveSimRow(
  baseScope: Scope,
  overrides: Partial<Record<SimFieldKey, string>>,
): ResolvedRow {
  const scope: Scope = { ...baseScope };
  const values = {} as Record<SimFieldKey, number>;
  const errors: Partial<Record<SimFieldKey, string>> = {};

  for (const field of SIM_FIELDS) {
    const override = overrides[field.key]?.trim();
    let value: number;
    if (override) {
      const res = safeEval(override, scope);
      if (res.error) {
        errors[field.key] = res.error;
        value = field.defaultFormula ? safeEval(field.defaultFormula, scope).value : (scope[field.key] ?? NaN);
      } else {
        value = res.value;
      }
    } else if (field.defaultFormula) {
      value = safeEval(field.defaultFormula, scope).value;
    } else {
      value = scope[field.key] ?? NaN;
    }
    values[field.key] = value;
    scope[field.key] = value;
  }

  return { values, errors, scope };
}
