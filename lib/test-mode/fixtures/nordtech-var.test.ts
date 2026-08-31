import { ccySpotRate } from '@/lib/fx-buffer';
import { computeAnalyticsVarUsdM, DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import { analyticsSpotUsd, marketSpotUsd, NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';

describe('analyticsSpotUsd', () => {
  it('keeps Task 01 curriculum pins (EUR = 1)', () => {
    expect(analyticsSpotUsd('EUR')).toBe(1);
    expect(analyticsSpotUsd('GBP')).toBe(NORDTECH_VAR.spotUsd.GBP);
  });

  it('uses TMS spots for JPY / MXN instead of 1.0', () => {
    expect(analyticsSpotUsd('JPY')).toBeCloseTo(ccySpotRate('JPY'), 8);
    expect(analyticsSpotUsd('MXN')).toBeCloseTo(ccySpotRate('MXN'), 8);
    expect(analyticsSpotUsd('JPY')).toBeLessThan(0.02);
  });

  it('market spots ignore Task 01 pins (PLN / EUR)', () => {
    expect(marketSpotUsd('EUR')).toBeCloseTo(ccySpotRate('EUR'), 8);
    expect(marketSpotUsd('PLN')).toBeCloseTo(ccySpotRate('PLN'), 8);
    expect(marketSpotUsd('PLN')).toBeCloseTo(0.2748612, 5);
    expect(marketSpotUsd('EUR')).not.toBe(1);
  });
});

describe('Group FX VaR · low-unit CCYs', () => {
  it('does not price −¥900M stock as −$900M', () => {
    const setup = {
      ...DEFAULT_VAR_SETUP,
      exposureBasis: 'stock' as const,
      confidencePct: 95 as const,
      horizon: '1m' as const,
    };
    const jpy = computeAnalyticsVarUsdM(-900, 0, 'JPY', setup);
    const ifSpotWereOne = 900 * 0.025 * NORDTECH_VAR.z95;
    expect(jpy).toBeGreaterThan(0.1);
    expect(jpy).toBeLessThan(0.5);
    expect(ifSpotWereOne).toBeGreaterThan(30);
    expect(jpy).toBeCloseTo(900 * ccySpotRate('JPY') * 0.025 * NORDTECH_VAR.z95, 6);
  });
});
