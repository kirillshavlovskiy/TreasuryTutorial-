import { Sequelize } from 'sequelize';

let sequelize: Sequelize | null | undefined;

/**
 * Resolve Postgres URL for local + Vercel.
 * Neon Marketplace may inject `ssigma_DATABASE_URL` / `ssigma_POSTGRES_URL`
 * instead of plain `DATABASE_URL`.
 */
export function resolveDatabaseUrl(): string | null {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.ssigma_DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.ssigma_POSTGRES_URL,
  ];
  for (const raw of candidates) {
    const url = raw?.trim();
    if (url) return url;
  }
  return null;
}

/** Shared Sequelize instance — null when no Postgres URL is configured. */
export function getSequelize(): Sequelize | null {
  if (sequelize !== undefined) return sequelize;

  const url = resolveDatabaseUrl();
  if (!url) {
    sequelize = null;
    return null;
  }

  // Internal cluster Postgres usually has no TLS; Neon/Vercel need sslmode=require.
  const useSsl =
    process.env.DATABASE_SSL === 'true' || url.includes('sslmode=require');

  sequelize = new Sequelize(url, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: useSsl
      ? {
          ssl: {
            require: true,
            // Managed cloud DBs often use proxied certs.
            rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true',
          },
        }
      : undefined,
  });

  return sequelize;
}

export function isDatabaseConfigured(): boolean {
  return Boolean(resolveDatabaseUrl());
}
