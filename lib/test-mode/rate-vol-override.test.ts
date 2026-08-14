import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VAR_SETUP,
  parseRateVolBpYr,
  parseVarSetup,
  RATE_VOL_BP_MAX,
  serializeRateVolOverride,
  type VarSetup,
} from '@/lib/test-mode/var-setup';
import {
  presetRateVolBpYr,
  RATE_DIFF_VOL_BP_YR,
  rateVolBpYrFor,
} from '@/lib/test-mode/cfar-residual';

const base: VarSetup = { ...DEFAULT_VAR_SETUP };

describe('rate-vol override resolution', () => {
  it('falls back to the per-currency desk table when nothing is set', () => {
    expect(rateVolBpYrFor('EUR', base)).toBe(RATE_DIFF_VOL_BP_YR.EUR);
    expect(rateVolBpYrFor('TRY', base)).toBe(RATE_DIFF_VOL_BP_YR.TRY);
    // USD is genuinely 0 in the table, so this also proves the resolver does
    // not treat a falsy table entry as "missing" and swap in the fallback.
    expect(rateVolBpYrFor('USD', base)).toBe(0);
    expect(rateVolBpYrFor('EUR', null)).toBe(RATE_DIFF_VOL_BP_YR.EUR);
  });

  it('uses the fallback for a currency the desk table does not know', () => {
    expect(rateVolBpYrFor('XYZ', base)).toBe(presetRateVolBpYr('XYZ'));
    expect(presetRateVolBpYr('XYZ')).toBeGreaterThan(0);
  });

  it('replaces the table for every currency once an override is set', () => {
    const setup: VarSetup = { ...base, rateVolOverrideBpYr: 120 };
    // The point of a single field: USD no longer sits at 0 while TRY sits at
    // 450 — otherwise cross-currency totals would mix two conventions.
    expect(rateVolBpYrFor('USD', setup)).toBe(120);
    expect(rateVolBpYrFor('EUR', setup)).toBe(120);
    expect(rateVolBpYrFor('TRY', setup)).toBe(120);
    expect(rateVolBpYrFor('XYZ', setup)).toBe(120);
  });

  it('honours an explicit zero rather than reading it as unset', () => {
    expect(rateVolBpYrFor('TRY', { ...base, rateVolOverrideBpYr: 0 })).toBe(0);
  });

  it('clamps an out-of-range override instead of passing it through', () => {
    expect(rateVolBpYrFor('EUR', { ...base, rateVolOverrideBpYr: 9999 })).toBe(
      RATE_VOL_BP_MAX,
    );
    expect(rateVolBpYrFor('EUR', { ...base, rateVolOverrideBpYr: -50 })).toBe(0);
    expect(rateVolBpYrFor('EUR', { ...base, rateVolOverrideBpYr: NaN })).toBe(
      RATE_DIFF_VOL_BP_YR.EUR,
    );
  });
});

describe('rate-vol override persistence', () => {
  it('parses blank, absent and out-of-range values back to the table', () => {
    expect(parseRateVolBpYr('')).toBeNull();
    expect(parseRateVolBpYr(undefined)).toBeNull();
    expect(parseRateVolBpYr('abc')).toBeNull();
    expect(parseRateVolBpYr('-1')).toBeNull();
    expect(parseRateVolBpYr(String(RATE_VOL_BP_MAX + 1))).toBeNull();
  });

  it('parses a legitimate value, including zero', () => {
    expect(parseRateVolBpYr('120')).toBe(120);
    expect(parseRateVolBpYr('0')).toBe(0);
    expect(parseRateVolBpYr(45)).toBe(45);
  });

  it('round-trips through serialize → parseVarSetup', () => {
    const answers = {
      varConfidencePct: '95',
      varExposureBasis: 'simpleAvg',
      varHorizon: '1m',
      varRateVol: serializeRateVolOverride({ rateVolOverrideBpYr: 120 }),
    };
    expect(answers.varRateVol).toBe('120');
    expect(parseVarSetup(answers)?.rateVolOverrideBpYr).toBe(120);
  });

  it('leaves the field off the setup when no override is stored', () => {
    expect(serializeRateVolOverride({ rateVolOverrideBpYr: undefined })).toBe('');
    const parsed = parseVarSetup({
      varConfidencePct: '95',
      varExposureBasis: 'simpleAvg',
      varHorizon: '1m',
      varRateVol: '',
    });
    expect(parsed).not.toBeNull();
    expect('rateVolOverrideBpYr' in parsed!).toBe(false);
  });

  it('survives answers saved before the field existed', () => {
    const parsed = parseVarSetup({
      varConfidencePct: '95',
      varExposureBasis: 'simpleAvg',
      varHorizon: '1m',
    });
    expect(parsed?.rateVolOverrideBpYr).toBeUndefined();
    expect(rateVolBpYrFor('EUR', parsed)).toBe(RATE_DIFF_VOL_BP_YR.EUR);
  });
});
