import { describe, expect, it } from 'vitest';
import {
  isRefinitivTokenExpiredMessage,
  stripRefinitivBearer,
} from '@/lib/refinitivPriceClient';

describe('Refinitiv token helpers', () => {
  it('detects the expired-access-token server message', () => {
    expect(
      isRefinitivTokenExpiredMessage(
        'Refinitiv access token has expired. Paste a fresh Bearer, or set REFINITIV_CLIENT_ID with USERNAME/PASSWORD or REFRESH_TOKEN to auto-renew.',
      ),
    ).toBe(true);
    expect(isRefinitivTokenExpiredMessage('IPA returned no curves')).toBe(false);
  });

  it('strips a Bearer prefix before storing the token', () => {
    expect(stripRefinitivBearer('Bearer eyJabc')).toBe('eyJabc');
    expect(stripRefinitivBearer('  eyJabc  ')).toBe('eyJabc');
  });
});
