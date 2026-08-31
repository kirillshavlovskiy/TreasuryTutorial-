import Decimal from 'decimal.js';
import { z } from 'zod';
import { INITIAL_ROWS, INITIAL_USD_PARAMS, roundMoney, type RowState, type UsdParams } from '@/lib/fx-buffer';
import { connectTreasuryMcpClient, isTreasuryMcpConfigured } from '@/lib/treasury/mcp-client';
import {
  getValidTreasuryAccessToken,
  TreasuryReauthRequiredError,
  TreasuryTemporarilyUnavailableError,
} from '@/lib/treasury/token-store';

/**
 * Live Treasury snapshot, overlaid onto the existing static book.
 *
 * Scope for this iteration: only `cash` (Notional Pool total, JPM + Citi,
 * FCY rows and the USD leg) is sourced live, from `investment_revenue_summary`
 * — a purpose-built NP feed that maps 1:1 onto what `RowState.cash` /
 * `usdCash` already mean. Non-NP local-book balances and net FX book
 * exposure ("spot"/"fwd") are deliberately NOT live-sourced yet:
 * `check_all_rails` mixes dozens of unrelated operational account uses
 * (payout floats, tax reserves, EOR/GP client money, corporate accounts,
 * ...) with no clean way to isolate "local books held outside the NP for
 * funding purposes", and `fx_pl_report` returns cumulative P&L / trade-
 * volume figures, not a net position — confirmed by direct calls against
 * the connected Treasury MCP, not assumed. Forcing either mapping would
 * produce a plausible-looking but wrong number in a book this sensitive.
 * Those fields keep their existing static values until Treasury confirms
 * the right source. CURRENCY_PARAMS (rates/spot) is untouched by design —
 * see decisions.md.
 */

export type TreasurySnapshotStatus =
  /** No Okta link for this user yet — book is the static baseline. */
  | 'not_connected'
  /** Live NP cash merged in successfully for at least one currency. */
  | 'live'
  /** Refresh token was rejected — link is gone, user must reconnect. */
  | 'reauth_required'
  /** Connected, but the fetch produced nothing usable — book fell back to static, not silently. */
  | 'error';

export interface TreasurySnapshot {
  rows: RowState[];
  usdCash: number;
  usdNonNpCash: number;
  usdParams: UsdParams;
  /** ISO currencies whose `cash` came from live Treasury data this fetch (excludes USD, tracked separately). */
  liveCurrencies: string[];
  /** True when usdCash itself came from the live feed rather than the static default. */
  usdCashIsLive: boolean;
  /** Conservative "as of": the oldest of every currency's own latest revenueDate in the raw fetch (not filtered to book/USD membership — see NpCashAggregate.asOfRevenueDate) — never the fetch's wall-clock time. */
  asOf: string;
  status: TreasurySnapshotStatus;
  /** Present only when status is 'error' — safe to show, never includes token/secret material. */
  errorMessage?: string;
}

export const revenueSummarySchema = z.object({
  count: z.number(),
  nextCursor: z.string().nullable().optional(),
  summaries: z.array(
    z.object({
      provider: z.string(),
      currency: z.string().transform(s => s.toUpperCase()),
      revenueDate: z.string(),
      balance: z.string(),
    }),
  ),
});

const LOOKBACK_DAYS = 7;
const FETCH_LIMIT = 1000;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** revenueDate arrives as a full ISO timestamp; tolerate a bare date too so a
 *  provider ever sending one format doesn't get silently excluded from the
 *  "latest per currency" grouping against the other provider's timestamps. */
function dateKey(revenueDate: string): string {
  return revenueDate.slice(0, 10);
}

export interface NpCashAggregate {
  /** ISO currency (incl. 'USD') -> NP total in millions of that currency. */
  cashByCurrency: Map<string, number>;
  /**
   * The OLDEST of each currency's own latest reported date, across every
   * currency present in the raw fetch — a conservative "as of", not the
   * freshest date seen, and NOT narrowed to only the currencies this book
   * tracks (a stale currency Treasury reports that isn't in the 24-currency
   * book, or isn't USD, still pulls this date back; that's the safe
   * direction — it can only make `asOf` look older than the book actually
   * is, never fresher). Reporting the global max here would mask a
   * laggard: e.g. EUR reported today and RSD reported 6 days ago (still
   * inside the lookback window) would otherwise render as "as of today"
   * even though the RSD figure driving its buffer sizing is 6 days stale.
   * The same conservatism applies one level deeper: a currency's own
   * "latest" is itself the oldest of its individual providers' latest
   * dates, so JPM reporting EUR today doesn't hide Citi's EUR row from
   * three days ago behind a falsely-fresh combined timestamp.
   * Null if no input rows.
   */
  asOfRevenueDate: string | null;
}

function providerCcyKey(provider: string, currency: string): string {
  return `${provider} ${currency}`;
}

/**
 * Sums NP balances (JPM + Citi) per currency, taking each PROVIDER's own
 * most recent reported date within the lookback window before summing
 * across providers — handles providers reporting on slightly different
 * days and multiple accounts per provider/currency.
 *
 * The "most recent" filter is keyed by (provider, currency), not currency
 * alone: filtering by currency alone would drop a lagging provider's row
 * entirely whenever a peer reports the same currency more recently — e.g.
 * JPM reports EUR today, Citi's latest EUR row is from yesterday (still
 * inside the lookback window) — keying by currency alone keeps only JPM's
 * row and silently halves the real EUR total instead of summing both
 * providers at their own respective latest dates.
 */
export function aggregateNpCashByCurrency(
  summaries: { provider: string; currency: string; revenueDate: string; balance: string }[],
): NpCashAggregate {
  const latestByProviderCcy = new Map<string, { key: string; raw: string }>();
  for (const row of summaries) {
    const key = dateKey(row.revenueDate);
    const pk = providerCcyKey(row.provider, row.currency);
    const current = latestByProviderCcy.get(pk);
    if (!current || key > current.key) {
      latestByProviderCcy.set(pk, { key, raw: row.revenueDate });
    }
  }

  // Per-currency "as of": the OLDEST of ITS OWN providers' latest dates —
  // the same conservative principle as the overall asOfRevenueDate below,
  // applied one level deeper (across providers within a currency), so a
  // lagging provider's staleness is never hidden behind a fresher peer's
  // timestamp for the same currency.
  const oldestProviderDateByCcy = new Map<string, string>();
  for (const [pk, { raw }] of latestByProviderCcy) {
    const currency = pk.slice(pk.indexOf(' ') + 1);
    const current = oldestProviderDateByCcy.get(currency);
    if (!current || raw < current) oldestProviderDateByCcy.set(currency, raw);
  }

  let asOfRevenueDate: string | null = null;
  for (const raw of oldestProviderDateByCcy.values()) {
    if (!asOfRevenueDate || raw < asOfRevenueDate) asOfRevenueDate = raw;
  }

  const totals = new Map<string, Decimal>();
  for (const row of summaries) {
    const pk = providerCcyKey(row.provider, row.currency);
    if (dateKey(row.revenueDate) !== latestByProviderCcy.get(pk)?.key) continue;
    const prior = totals.get(row.currency) ?? new Decimal(0);
    totals.set(row.currency, prior.plus(new Decimal(row.balance)));
  }

  const cashByCurrency = new Map<string, number>();
  for (const [ccy, total] of totals) {
    // Balances are native-currency units; RowState.cash/usdCash are in millions.
    cashByCurrency.set(ccy, roundMoney(total.dividedBy(1_000_000).toNumber(), 8));
  }
  return { cashByCurrency, asOfRevenueDate };
}

function staticSnapshot(status: TreasurySnapshotStatus, errorMessage?: string): TreasurySnapshot {
  return {
    rows: INITIAL_ROWS.map(r => ({ ...r })),
    usdCash: 303.9,
    usdNonNpCash: 154.1,
    usdParams: { ...INITIAL_USD_PARAMS },
    liveCurrencies: [],
    usdCashIsLive: false,
    asOf: new Date(0).toISOString(),
    status,
    errorMessage,
  };
}

/**
 * Fetches the live NP cash overlay for `email` and merges it onto the
 * existing static book. Never throws — a failed or empty fetch falls back
 * to the static book with `status: 'error'` (and `errorMessage`) so the
 * caller can show that honestly rather than rendering stale numbers as live.
 */
export async function getTreasurySnapshotForUser(email: string): Promise<TreasurySnapshot> {
  if (!isTreasuryMcpConfigured()) return staticSnapshot('not_connected');

  let accessToken: string | null;
  try {
    accessToken = await getValidTreasuryAccessToken(email);
  } catch (err) {
    if (err instanceof TreasuryReauthRequiredError) return staticSnapshot('reauth_required');
    if (err instanceof TreasuryTemporarilyUnavailableError) {
      console.warn('[treasury/snapshot] token refresh temporarily unavailable', err);
      return staticSnapshot('error', err.message);
    }
    console.error('[treasury/snapshot] token lookup failed', err);
    return staticSnapshot('error', 'Could not verify your Treasury connection.');
  }
  if (!accessToken) return staticSnapshot('not_connected');

  let client: Awaited<ReturnType<typeof connectTreasuryMcpClient>>;
  try {
    client = await connectTreasuryMcpClient(accessToken);
  } catch (err) {
    console.error('[treasury/snapshot] MCP connect failed', err);
    return staticSnapshot('error', 'Treasury data is temporarily unavailable — showing the static book.');
  }

  try {
    const dateTo = new Date();
    const dateFrom = new Date(dateTo.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const result = await client.callTool(
      'investment_revenue_summary',
      { dateFrom: isoDate(dateFrom), dateTo: isoDate(dateTo), limit: FETCH_LIMIT },
      revenueSummarySchema,
    );

    if (result.nextCursor) {
      // `nextCursor` present is, by itself, authoritative that more pages
      // exist — a truncated sum still looks like a plausible balance, the
      // worst failure mode for this book, so this is not a warn-and-continue.
      console.warn('[treasury/snapshot] investment_revenue_summary result is paginated — refusing a partial sum', {
        count: result.count,
        limit: FETCH_LIMIT,
      });
      return staticSnapshot('error', 'Treasury returned more Notional Pool data than expected — showing the static book.');
    }

    const { cashByCurrency, asOfRevenueDate } = aggregateNpCashByCurrency(result.summaries);
    if (cashByCurrency.size === 0 || !asOfRevenueDate) {
      return staticSnapshot('error', 'Treasury returned no recent Notional Pool balances — showing the static book.');
    }

    const base = staticSnapshot('live');
    const rows = base.rows.map(row => {
      const liveCash = cashByCurrency.get(row.ccy);
      return liveCash === undefined ? row : { ...row, cash: liveCash };
    });
    const liveCurrencies = rows.filter(r => cashByCurrency.has(r.ccy)).map(r => r.ccy);
    const usdCashLive = cashByCurrency.get('USD');

    if (liveCurrencies.length === 0 && usdCashLive === undefined) {
      // cashByCurrency was non-empty, but none of it matched a currency this
      // book actually tracks (nor USD) — nothing was really overlaid, so
      // don't claim 'live' over what is, in effect, still the static book.
      return staticSnapshot('error', 'Treasury data did not match any currency in this book — showing the static book.');
    }

    return {
      ...base,
      rows,
      liveCurrencies,
      usdCash: usdCashLive ?? base.usdCash,
      usdCashIsLive: usdCashLive !== undefined,
      asOf: asOfRevenueDate,
    };
  } catch (err) {
    console.error('[treasury/snapshot] MCP fetch failed', err);
    return staticSnapshot('error', 'Treasury data is temporarily unavailable — showing the static book.');
  } finally {
    await client.close().catch(err => {
      console.warn('[treasury/snapshot] error closing MCP client (ignored)', err);
    });
  }
}
