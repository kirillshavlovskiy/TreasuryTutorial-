import { z } from 'zod';
import { connectTreasuryMcpClient, isTreasuryMcpConfigured } from '@/lib/treasury/mcp-client';
import {
  getValidTreasuryAccessToken,
  TreasuryReauthRequiredError,
  TreasuryTemporarilyUnavailableError,
} from '@/lib/treasury/token-store';

/**
 * Live FX market rates via the Treasury Finance MCP `fx_rate_lookup` tool
 * (market pairs mode only — no central bank rates, no historical date, no
 * inverse pairs; see docs/architecture.md for scope). PoC: unlike
 * snapshot.ts this does not merge onto any book, it just surfaces what
 * Treasury returns, and it opens/closes one MCP connection per call — no
 * caching. Requires the `fx_rates: READ` TMS permission; a user without it
 * gets a status: 'error' with the tool's own permission-denial message.
 */

export interface FxRatePair {
  base: string;
  target: string;
}

export type FxRatesStatus = 'not_connected' | 'live' | 'reauth_required' | 'error';

export interface FxRateRow {
  base: string;
  target: string;
  rate: number;
}

export interface FxRatesResult {
  status: FxRatesStatus;
  rates: FxRateRow[];
  missing: FxRatePair[];
  /** When the lookup ran — these are 'latest' rates, they have no asOf of their own. */
  fetchedAt: string;
  /** Present only when status is 'error' — safe to show, never includes token/secret material. */
  errorMessage?: string;
}

/** Server-side cap on `fx_rate_lookup`'s `pairs` argument. */
export const MAX_PAIRS = 100;

const CCY_CODE_RE = /^[A-Za-z]{3}$/;

/**
 * Response shape for market-mode `fx_rate_lookup`. Deliberately non-strict:
 * `buildFinanceToolResult` on the Treasury side always adds a `summary` key
 * and sometimes a `followUp` key alongside the tool's own body — zod objects
 * ignore unknown keys by default, so those pass through untouched.
 */
export const fxRateLookupSchema = z.object({
  mode: z.literal('market'),
  date: z.string(),
  asOfTime: z.string().nullable(),
  results: z.array(
    z.object({
      base: z.string(),
      target: z.string(),
      rate: z.number(),
      inverse: z.literal(true).optional(),
    }),
  ),
  missing: z.array(
    z.object({
      base: z.string(),
      target: z.string(),
      inverse: z.literal(true).optional(),
    }),
  ),
  summary: z.string().optional(),
});

/**
 * Validates and normalizes a request body's `pairs` field: uppercases
 * 3-letter currency codes, drops exact duplicates, and enforces the same
 * 1..MAX_PAIRS bound the MCP tool itself enforces (so a caller finds out
 * from this app rather than from an opaque Treasury 400). Returns a plain
 * `{ error }` object rather than throwing — this is request-body validation
 * for the route handler, not an exceptional condition.
 */
export function parsePairsInput(raw: unknown): FxRatePair[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Provide at least one { base, target } currency pair.' };
  }

  const seen = new Set<string>();
  const pairs: FxRatePair[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      return { error: 'Each pair must be an object with "base" and "target" currency codes.' };
    }
    const { base, target } = entry as Record<string, unknown>;
    if (typeof base !== 'string' || typeof target !== 'string') {
      return { error: 'Each pair must have "base" and "target" as strings.' };
    }
    const b = base.trim().toUpperCase();
    const t = target.trim().toUpperCase();
    if (!CCY_CODE_RE.test(b) || !CCY_CODE_RE.test(t)) {
      return { error: `Invalid currency code in pair "${base}/${target}" — expected a 3-letter ISO code.` };
    }
    const key = `${b}:${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ base: b, target: t });
  }

  if (pairs.length === 0) {
    return { error: 'Provide at least one { base, target } currency pair.' };
  }
  if (pairs.length > MAX_PAIRS) {
    return { error: `Too many pairs — up to ${MAX_PAIRS} allowed, got ${pairs.length}.` };
  }

  return pairs;
}

function emptyResult(status: FxRatesStatus, errorMessage?: string): FxRatesResult {
  return { status, rates: [], missing: [], fetchedAt: new Date().toISOString(), errorMessage };
}

/**
 * Fetches live market rates for `pairs` via `fx_rate_lookup`, using the
 * caller's own Treasury OAuth link. Never throws — every failure mode
 * (no link, expired link, MCP unreachable, permission denial, empty
 * response) comes back as `status !== 'live'` with an honest message, the
 * same contract as `getTreasurySnapshotForUser`.
 */
export async function getTreasuryFxRatesForUser(email: string, pairs: FxRatePair[]): Promise<FxRatesResult> {
  if (!isTreasuryMcpConfigured()) return emptyResult('not_connected');

  let accessToken: string | null;
  try {
    accessToken = await getValidTreasuryAccessToken(email);
  } catch (err) {
    if (err instanceof TreasuryReauthRequiredError) return emptyResult('reauth_required');
    if (err instanceof TreasuryTemporarilyUnavailableError) {
      console.warn('[treasury/fx-rates] token refresh temporarily unavailable', err);
      return emptyResult('error', err.message);
    }
    console.error('[treasury/fx-rates] token lookup failed', err);
    return emptyResult('error', 'Could not verify your Treasury connection.');
  }
  if (!accessToken) return emptyResult('not_connected');

  let client: Awaited<ReturnType<typeof connectTreasuryMcpClient>>;
  try {
    client = await connectTreasuryMcpClient(accessToken);
  } catch (err) {
    console.error('[treasury/fx-rates] MCP connect failed', err);
    return emptyResult('error', 'Treasury data is temporarily unavailable — try again shortly.');
  }

  try {
    const fetchedAt = new Date().toISOString();
    const data = await client.callTool('fx_rate_lookup', { pairs }, fxRateLookupSchema);

    if (data.results.length === 0) {
      // Non-empty pairs input but nothing usable came back — don't report
      // 'live' over an empty table (same conservatism as snapshot.ts).
      return emptyResult(
        'error',
        data.missing.length > 0
          ? `Treasury returned no rate for any of the ${data.missing.length} requested pair(s).`
          : 'Treasury returned no rates for the requested pairs.',
      );
    }

    return {
      status: 'live',
      rates: data.results.map(r => ({ base: r.base, target: r.target, rate: r.rate })),
      missing: data.missing.map(m => ({ base: m.base, target: m.target })),
      fetchedAt,
    };
  } catch (err) {
    console.error('[treasury/fx-rates] fx_rate_lookup failed', err);
    // err.message here is either a schema-mismatch message from
    // parseToolResult (safe — names no secrets) or, when the tool itself
    // returned isError, the tool's own human-authored text (e.g. a
    // "fx_rates: READ" permission denial, or "FX rate lookup is not
    // available" when FX_RATE_API_URL is unset on Treasury's side).
    // Treasury's own errorMessage() already strips infra details (DB/
    // connection internals) before a tool error ever reaches this text, so
    // it's safe to surface verbatim — the user needs to know *why*.
    return emptyResult('error', err instanceof Error ? err.message : 'Treasury data is temporarily unavailable — try again shortly.');
  } finally {
    await client.close().catch(err => {
      console.warn('[treasury/fx-rates] error closing MCP client (ignored)', err);
    });
  }
}
