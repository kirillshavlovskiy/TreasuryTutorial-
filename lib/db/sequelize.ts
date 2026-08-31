import dns from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { Sequelize } from 'sequelize';
import {
  Client,
  Pool,
  defaults,
  neonConfig,
  types,
} from '@neondatabase/serverless';
import WebSocket from 'ws';

/**
 * Node 17+ defaults to ipv6first. Neon AAAA + Windows / corp firewalls fail
 * with SequelizeConnectionError AggregateError EACCES on sandbox PUT/GET.
 */
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

let sequelize: Sequelize | null | undefined;
let neonDriverConfigured = false;

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

function isNeonUrl(url: string): boolean {
  return /neon\.(tech|build)/i.test(url);
}

function sslRejectUnauthorized(): boolean {
  return process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true';
}

/**
 * Neon over TCP :5432 is blocked on many corp Windows boxes (EACCES even to
 * 8.8.8.8:5432). The serverless driver uses HTTPS/WSS on :443 instead.
 * SSL inspection MITM needs the same rejectUnauthorized=false default as pg.
 *
 * `ws` / `@neondatabase/serverless` stay in next.config serverExternalPackages
 * so webpack does not stub bufferutil (`bufferUtil.mask is not a function`).
 */
function configureNeonServerlessDriver(): void {
  if (neonDriverConfigured) return;
  neonDriverConfigured = true;

  const rejectUnauthorized = sslRejectUnauthorized();
  neonConfig.webSocketConstructor = class NeonWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { rejectUnauthorized });
    }
  } as unknown as typeof neonConfig.webSocketConstructor;

  if (!rejectUnauthorized) {
    const agent = new Agent({ connect: { rejectUnauthorized: false } });
    neonConfig.fetchFunction = (input: string | URL, init?: RequestInit) =>
      // undici's RequestInit is nominally distinct from the DOM lib's — it
      // carries its own BodyInit/FormData types — so this boundary needs a
      // cast, the same reason webSocketConstructor above is cast. Type-only:
      // `dispatcher` is undici's own option and everything else is passed
      // through verbatim, so runtime behaviour is unchanged.
      undiciFetch(String(input), { ...init, dispatcher: agent } as unknown as Parameters<typeof undiciFetch>[1]);
  }
}

function dialectOptionsFor(url: string): Record<string, unknown> {
  const neon = isNeonUrl(url);
  const useSsl =
    process.env.DATABASE_SSL === 'true'
    || url.includes('sslmode=require')
    || neon;
  const familyEnv = process.env.DATABASE_IP_FAMILY?.trim();
  const family = familyEnv === '6' ? 6 : 4;

  return {
    family,
    ...(useSsl
      ? {
          ssl: {
            require: true,
            rejectUnauthorized: sslRejectUnauthorized(),
          },
        }
      : {}),
  };
}

/** Shared Sequelize instance — null when no Postgres URL is configured. */
export function getSequelize(): Sequelize | null {
  if (sequelize !== undefined) return sequelize;

  const url = resolveDatabaseUrl();
  if (!url) {
    sequelize = null;
    return null;
  }

  const neon = isNeonUrl(url);
  if (neon) configureNeonServerlessDriver();

  sequelize = new Sequelize(url, {
    dialect: 'postgres',
    logging: false,
    dialectModule: neon ? { Client, Pool, types, defaults } : undefined,
    dialectOptions: dialectOptionsFor(url),
  });

  return sequelize;
}

export function isDatabaseConfigured(): boolean {
  return Boolean(resolveDatabaseUrl());
}

/** True for refused / blocked / DNS failures — not constraint or SQL errors. */
export function isDatabaseUnreachable(err: unknown): boolean {
  const e = err as {
    name?: string;
    message?: string;
    parent?: { code?: string; message?: string };
    original?: { code?: string; message?: string };
    code?: string;
  };
  const code = e.parent?.code ?? e.original?.code ?? e.code ?? '';
  const msg = `${e.message ?? ''} ${e.parent?.message ?? ''} ${e.original?.message ?? ''}`;
  return (
    e.name === 'SequelizeConnectionError'
    || e.name === 'SequelizeConnectionRefusedError'
    || e.name === 'SequelizeHostNotFoundError'
    || e.name === 'SequelizeHostNotReachableError'
    || e.name === 'SequelizeConnectionTimedOutError'
    || code === 'EACCES'
    || code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || code === 'ENOTFOUND'
    || code === 'EHOSTUNREACH'
    || /connection terminated/i.test(msg)
    || /bufferUtil\.mask is not a function/i.test(msg)
  );
}
