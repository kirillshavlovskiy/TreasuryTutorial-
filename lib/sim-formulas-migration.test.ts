import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_REFS,
  RENAMED_SIM_REFS,
  SIM_FIELDS,
  migrateFormulaExpression,
  migrateFormulaKey,
  migrateFormulaOverrides,
  resolveSimRow,
} from '@/lib/sim-formulas';

describe('renamed reference map', () => {
  it('points every old name at a name the engine actually binds', () => {
    // Guards the rename itself: a typo in the map would migrate a saved
    // formula onto a reference that does not exist, which fails silently at
    // eval time rather than at build time.
    const bound = new Set<string>([
      ...SIM_FIELDS.map(f => f.key),
      ...AVAILABLE_REFS.map(r => r.name),
    ]);
    for (const [, next] of Object.entries(RENAMED_SIM_REFS)) {
      expect(bound.has(next), `${next} is not a known reference`).toBe(true);
    }
  });

  it('leaves no old name still in use as a live reference', () => {
    const live = new Set<string>([
      ...SIM_FIELDS.map(f => f.key),
      ...AVAILABLE_REFS.map(r => r.name),
    ]);
    for (const old of Object.keys(RENAMED_SIM_REFS)) {
      expect(live.has(old), `${old} was renamed but is still bound`).toBe(false);
    }
  });
});

describe('migrateFormulaKey', () => {
  it('rewrites the field segment of a simulator cell key', () => {
    expect(migrateFormulaKey('EUR::npSwap')).toBe('EUR::lpSwap');
    expect(migrateFormulaKey('GBP::targetNpCashUSD')).toBe('GBP::targetLpCashUSD');
  });

  it('rewrites the field segment of a forecast cell key, keeping the month', () => {
    expect(migrateFormulaKey('EUR::npSwap::7')).toBe('EUR::lpSwap::7');
  });

  it('leaves untouched keys alone', () => {
    expect(migrateFormulaKey('EUR::cycleEnd')).toBe('EUR::cycleEnd');
    expect(migrateFormulaKey('EUR')).toBe('EUR');
    expect(migrateFormulaKey('')).toBe('');
  });

  it('only treats segment 1 as a field name', () => {
    // A currency literally called npSwap is absurd, but the point is that the
    // migration is positional and cannot corrupt other segments.
    expect(migrateFormulaKey('npSwap::cycleEnd')).toBe('npSwap::cycleEnd');
  });
});

describe('migrateFormulaExpression', () => {
  it('rewrites references the user typed', () => {
    expect(migrateFormulaExpression('npSwap * spotRate')).toBe('lpSwap * spotRate');
    expect(migrateFormulaExpression('npSwap + payout + nonNpCash')).toBe(
      'lpSwap + payout + nonLpCash',
    );
  });

  it('prefers the longer name when one is a prefix of another', () => {
    expect(migrateFormulaExpression('npSwapUSD')).toBe('lpSwapUSD');
    expect(migrateFormulaExpression('npSwapUSD + npSwap')).toBe('lpSwapUSD + lpSwap');
  });

  it('does not rewrite a name embedded in a longer identifier', () => {
    expect(migrateFormulaExpression('myNpSwap')).toBe('myNpSwap');
    expect(migrateFormulaExpression('npSwapExtra')).toBe('npSwapExtra');
  });

  it('is idempotent', () => {
    const once = migrateFormulaExpression('npSwap * spotRate');
    expect(migrateFormulaExpression(once)).toBe(once);
  });
});

describe('migrateFormulaOverrides', () => {
  it('migrates keys and expressions together', () => {
    expect(
      migrateFormulaOverrides({
        'EUR::npSwap': 'cash + swapNear',
        'EUR::cycleEnd': 'npSwap + payout + nonNpCash',
      }),
    ).toEqual({
      'EUR::lpSwap': 'cash + swapNear',
      'EUR::cycleEnd': 'lpSwap + payout + nonLpCash',
    });
  });

  it('returns the identical object when nothing needs migrating', () => {
    const input = { 'EUR::cycleEnd': 'lpSwap + payout' };
    // Reference equality, so the caller can skip rewriting the workspace.
    expect(migrateFormulaOverrides(input)).toBe(input);
    expect(migrateFormulaOverrides({})).toEqual({});
  });

  it('does not let a migrated entry clobber one already under the new name', () => {
    expect(
      migrateFormulaOverrides({
        'EUR::npSwap': 'stale',
        'EUR::lpSwap': 'current',
      }),
    ).toEqual({ 'EUR::lpSwap': 'current' });
  });

  it('is idempotent', () => {
    const once = migrateFormulaOverrides({ 'EUR::npSwap': 'npSwap * 2' });
    expect(migrateFormulaOverrides(once)).toEqual(once);
  });

  it('produces overrides the engine can actually evaluate', () => {
    // End to end: a formula saved under the old vocabulary still computes.
    const migrated = migrateFormulaOverrides({ 'EUR::npSwap': 'cash + swapNear + 5' });
    const scope = { cash: 10, swapNear: 2, spotRate: 1.1, modelTarget: 12, modelTrough: 0, modelCycleNet: 0, modelCycleEnd: 0, modelCycleFlow: 0 };
    const key = Object.keys(migrated)[0].split('::')[1] as 'lpSwap';
    const resolved = resolveSimRow(scope, { [key]: migrated['EUR::lpSwap'] });
    expect(resolved.errors.lpSwap).toBeUndefined();
    expect(resolved.values.lpSwap).toBe(17);
  });
});
