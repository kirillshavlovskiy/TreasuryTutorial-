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

/** Desk-module snapshot / action tables, same UAT vs production split. */
export type DeskTableKind =
  | 'workspace'
  | 'fx_book'
  | 'liquidity'
  | 'analytics'
  | 'hedge'
  | 'action';

export function deskTableName(
  kind: DeskTableKind,
  env: SandboxStorageEnv = getSandboxStorageEnv(),
): string {
  const suffix = env === 'production' ? 'production' : 'uat';
  return `desk_${kind}_${suffix}`;
}

/**
 * Curriculum / practice progress — queryable steps, answers, scores.
 * Separate from the sandbox JSON blob so dashboards can list completion
 * without loading the full workspace.
 */
export type UserProgressTableKind = 'snapshot' | 'step' | 'event';

export function userProgressTableName(
  kind: UserProgressTableKind = 'snapshot',
  env: SandboxStorageEnv = getSandboxStorageEnv(),
): string {
  const suffix = env === 'production' ? 'production' : 'uat';
  if (kind === 'step') return `user_progress_step_${suffix}`;
  if (kind === 'event') return `user_progress_event_${suffix}`;
  return `user_progress_${suffix}`;
}

export type StorageLayer =
  | 'sandbox_blob'
  | 'desk_modules'
  | 'user_progress'
  | 'browser_cache';

/** Map of where each class of user data lives. */
export const STORAGE_CATALOG: Record<
  StorageLayer,
  { role: string; tables?: string[]; browserKeys?: string[] }
> = {
  sandbox_blob: {
    role: 'Full sandbox restore (workspace, hedges, answers, UI)',
    tables: ['sandbox_progress_{env}'],
  },
  desk_modules: {
    role: 'Normalized FX / Liquidity / Analytics / Hedging snapshots + action log',
    tables: [
      'desk_workspace_{env}',
      'desk_fx_book_{env}',
      'desk_liquidity_{env}',
      'desk_analytics_{env}',
      'desk_hedge_{env}',
      'desk_action_{env}',
    ],
  },
  user_progress: {
    role: 'Steps completed, answers, Validate score, progress events',
    tables: [
      'user_progress_{env}',
      'user_progress_step_{env}',
      'user_progress_event_{env}',
    ],
  },
  browser_cache: {
    role: 'Offline / guest cache until Postgres is reachable',
    browserKeys: [
      'treasury:test:{userKey}',
      'treasury:ws:{userKey}',
      'treasury:sandbox-mode',
      'ss-agent-chat:v1:{scope}',
      'ss-market-rates:{scope}',
    ],
  },
};
