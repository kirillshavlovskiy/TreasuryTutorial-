/** Logical data partition on a shared Postgres connection. */
export type SandboxStorageEnv = 'uat' | 'production';

/**
 * Resolve UAT vs production storage.
 * Same DATABASE_URL; rows live in separate tables.
 *
 * Priority:
 * 1. SANDBOX_STORAGE_ENV=uat|production|prod
 * 2. VERCEL_ENV=production → production; preview/development → uat
 * 3. NODE_ENV=production without Vercel → production
 * 4. Default → uat (safe for local)
 */
export function getSandboxStorageEnv(): SandboxStorageEnv {
  const explicit = process.env.SANDBOX_STORAGE_ENV?.trim().toLowerCase();
  if (explicit === 'production' || explicit === 'prod') return 'production';
  if (explicit === 'uat') return 'uat';

  if (process.env.VERCEL_ENV === 'production') return 'production';
  if (process.env.VERCEL_ENV === 'preview' || process.env.VERCEL_ENV === 'development') {
    return 'uat';
  }

  if (process.env.NODE_ENV === 'production') return 'production';
  return 'uat';
}

/** Table name for the active storage environment. */
export function sandboxProgressTableName(
  env: SandboxStorageEnv = getSandboxStorageEnv(),
): string {
  return env === 'production'
    ? 'sandbox_progress_production'
    : 'sandbox_progress_uat';
}
