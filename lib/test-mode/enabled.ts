/**
 * Test Dashboard is sandbox-only. Requires TEST_MODE_ENABLED=true.
 * In production it stays off unless TEST_MODE_ALLOW_PROD=true is set explicitly.
 */
export function isTestModeEnabled(): boolean {
  if (process.env.TEST_MODE_ENABLED !== 'true') return false;
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.TEST_MODE_ALLOW_PROD !== 'true'
  ) {
    return false;
  }
  return true;
}

export const TEST_GUEST_EMAIL = 'test@sigma.local';
export const TEST_GUEST_NAME = 'Sigma Test Guest';
