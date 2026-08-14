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
  | 'targetLpCash' | 'targetLpCashUSD'
  | 'swapNear' | 'swapUSD' | 'lpSwap' | 'lpSwapUSD' | 'cycleEnd' | 'cycleEndUSD'
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
  // modelTrough is cash + payout unless forecast liquidity timing is on, in
  // which case it is the dated path low including FX settlement, no funding swap.
  { key: 'troughCash',    label: 'Trough Cash',        section: 'liquidity', defaultFormula: 'modelTrough' },
  // modelCycleNet is totalCash + payout + collections unless liquidity timing
  // is on, where it is the cycle-1 closing across every forecast cash line.
  { key: 'totalCash',     label: 'Closing Balance',    section: 'liquidity', defaultFormula: 'modelCycleNet' },
  // A flow, not a balance: what lands and leaves inside the cycle.
  { key: 'cycleNetFlow',  label: 'Cycle Net Flow',     section: 'liquidity', defaultFormula: 'modelCycleFlow' },
  { key: 'totalCashUSD',  label: 'Closing Balance $USD', section: 'liquidity', defaultFormula: 'totalCash * spotRate' },
  { key: 'swapNear',      label: 'Swap Near',          section: 'swap',      defaultFormula: '' },
  { key: 'targetLpCash',  label: 'Target LP Cash',     section: 'carry',     defaultFormula: 'cash + swapNear' },
  { key: 'targetLpCashUSD', label: 'Target LP Cash $USD', section: 'carry',  defaultFormula: 'targetLpCash * spotRate' },
  { key: 'swapUSD',       label: 'Swap $USD',          section: 'swap',      defaultFormula: 'swapNear * spotRate' },
  { key: 'lpSwap',        label: 'LP+Swap',            section: 'swap',      defaultFormula: 'cash + swapNear' },
  { key: 'lpSwapUSD',     label: 'LP+Swap $USD',       section: 'swap',      defaultFormula: 'lpSwap * spotRate' },
  { key: 'cycleEnd',      label: 'Cycle End',          section: 'swap',      defaultFormula: 'modelCycleEnd' },
  { key: 'cycleEndUSD',   label: 'Cycle End $USD',     section: 'swap',      defaultFormula: 'cycleEnd * spotRate' },
  { key: 'fwdHedgeUSD',   label: 'Fwd Hedge $USD',     section: 'hedge',     defaultFormula: 'fwdNotional * spotRate' },
  { key: 'optionHedgeUSD', label: 'Option Hedge $USD', section: 'hedge',     defaultFormula: 'optNotional * optDelta * spotRate' },
];

export const SIM_FIELD_BY_KEY: Record<SimFieldKey, SimFieldDef> =
  Object.fromEntries(SIM_FIELDS.map(f => [f.key, f])) as Record<SimFieldKey, SimFieldDef>;

/**
 * Names that changed when Notional Pool was renamed Liquidity Pool.
 *
 * Both halves of a saved override are affected: the storage key carries a
 * field name (`${ccy}::npSwap`), and the expression the user typed may cite
 * any of these as a reference (`npSwap * spotRate`). Migrating only the key
 * would leave formulas that reference a name the evaluator no longer binds.
 */
export const RENAMED_SIM_REFS: Readonly<Record<string, string>> = {
  npSwap: 'lpSwap',
  npSwapUSD: 'lpSwapUSD',
  targetNpCash: 'targetLpCash',
  targetNpCashUSD: 'targetLpCashUSD',
  nonNpCash: 'nonLpCash',
};

// Longest first: ordered alternation, so npSwapUSD is matched before npSwap.
const RENAMED_REF_RE = new RegExp(
  `\\b(${Object.keys(RENAMED_SIM_REFS)
    .sort((a, b) => b.length - a.length)
    .join('|')})\\b`,
  'g',
);

/** Rewrite old reference names inside a user-authored formula expression. */
export function migrateFormulaExpression(expr: string): string {
  return expr.replace(RENAMED_REF_RE, m => RENAMED_SIM_REFS[m] ?? m);
}

/**
 * Rewrite the field-name segment of an override key. Keys are
 * `${ccy}::${fieldKey}` for simulator cells and `${ccy}::${field}::${monthIdx}`
 * for forecast cells; only the segment at index 1 is a field name, so a
 * currency or month that happens to collide with a renamed field is untouched.
 */
export function migrateFormulaKey(key: string): string {
  const parts = key.split('::');
  if (parts.length < 2) return key;
  const renamed = RENAMED_SIM_REFS[parts[1]];
  if (!renamed) return key;
  parts[1] = renamed;
  return parts.join('::');
}

/**
 * Migrate a saved override map. Returns the same object when nothing changed
 * so callers can skip writing back an identical workspace.
 *
 * A pre-existing entry under the new name wins: if a dashboard somehow holds
 * both, the migrated one must not silently overwrite what the user last
 * edited under the current name.
 */
export function migrateFormulaOverrides(
  formulas: Record<string, string>,
): Record<string, string> {
  let changed = false;
  const out: Record<string, string> = {};
  for (const [key, expr] of Object.entries(formulas)) {
    const nextKey = migrateFormulaKey(key);
    const nextExpr = migrateFormulaExpression(expr);
    if (nextKey !== key || nextExpr !== expr) changed = true;
    if (nextKey !== key && Object.hasOwn(formulas, nextKey)) continue;
    out[nextKey] = nextExpr;
  }
  return changed ? out : formulas;
}

/** Named references a user may use in a formula (row inputs + computed values). */
export const AVAILABLE_REFS: { name: string; desc: string }[] = [
  { name: 'cash',           desc: 'Opening LP cash (M FCY)' },
  { name: 'payout',         desc: 'Gross payouts (M FCY, negative = outflow)' },
  { name: 'collections',    desc: 'Gross payins (M FCY)' },
  { name: 'nonLpCash',      desc: 'Non-LP cash (M FCY)' },
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
  { name: 'modelTrough',    desc: 'Model trough cash — dated path low including FX settlement, no funding swap (M FCY)' },
  { name: 'modelCycleNet',  desc: 'Model closing balance — cycle-1 close across all forecast lines, before the swap (M FCY)' },
  { name: 'modelCycleEnd',  desc: 'Model cycle-end cash — last close on the dated path after hedge settlement and the term far-leg repayment (M FCY)' },
  { name: 'modelCycleFlow', desc: 'Model cycle net flow — payins − payouts inside one cycle (M FCY)' },
  { name: 'troughCash',     desc: 'Trough cash (resolved)' },
  { name: 'totalCash',      desc: 'Closing balance (resolved)' },
  { name: 'swapNear',       desc: 'Swap near leg (resolved)' },
  { name: 'targetLpCash',   desc: 'Target LP cash (resolved)' },
  { name: 'lpSwap',         desc: 'LP + swap (resolved)' },
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
