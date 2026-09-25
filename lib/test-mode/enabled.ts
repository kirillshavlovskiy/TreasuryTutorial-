/**
 * Single gate for Sandbox / Sigma Tasks (`/test`) and all Sandbox UI links.
 *
 * The module is always present: local and production behave identically and
 * TEST_MODE_ENABLED / TEST_MODE_ALLOW_PROD are no longer consulted, so the
 * Sandbox link can never point at a route that redirects home.
 */
export function isTestModeEnabled(): boolean {
  return true;
}

export const TEST_GUEST_EMAIL = 'test@sigma.local';
export const TEST_GUEST_NAME = 'Sigma Test Guest';
