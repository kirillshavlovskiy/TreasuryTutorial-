import { z } from 'zod';
import { withTreasuryClient } from '@/lib/treasury/mcp-client';

/**
 * `notional_pool_overview`, `notional_pool_daily_metrics`, `notional_pool_rate_snapshot` and
 * `notional_pool_rate_history` via the Treasury Finance MCP. All four require
 * `interest_rates: READ`.
 *
 * Response shapes below are read directly from treasury's
 * app/src/services/notional_pool/notional_pool_service.ts
 * (`INotionalPoolOverview`, `INotionalPoolDailyMetricsResult`) and
 * app/src/services/notional_pool/notional_pool_rate_service.ts
 * (`IRateSnapshotResult`, `IRateHistoryEntry`), not inferred from the tool descriptions.
 */

export type NotionalPoolStatus = 'not_connected' | 'live' | 'reauth_required' | 'error';

// --- notional_pool_overview ---------------------------------------------------------------

const providerInterestBreakdownSchema = z.object({
  citi: z.object({ interest: z.number() }),
  jpmorgan: z.object({ interest: z.number() }),
  total: z.object({ interest: z.number() }),
});

const providerBalanceBreakdownSchema = z.object({
  citi: z.object({ balance: z.number() }),
  jpmorgan: z.object({ balance: z.number() }),
  total: z.object({ balance: z.number() }),
});

export const notionalPoolOverviewSchema = z.object({
  overview: z.object({
    interest: z.object({
      monthToDate: z.object({ dateFrom: z.string(), dateTo: z.string(), data: providerInterestBreakdownSchema }),
      yearToDate: z.object({ dateFrom: z.string(), dateTo: z.string(), data: providerInterestBreakdownSchema }),
    }),
    balance: z.object({
      current: z.object({ data: providerBalanceBreakdownSchema }),
      monthToDateAverage: z.object({ dateFrom: z.string(), dateTo: z.string(), data: providerBalanceBreakdownSchema }),
    }),
  }),
  populated: z.object({ currency: z.object({ code: z.string(), symbol: z.string().nullable() }) }),
  summary: z.string().optional(),
});

export type NotionalPoolOverview = z.infer<typeof notionalPoolOverviewSchema>['overview'];

export interface NotionalPoolOverviewResult {
  status: NotionalPoolStatus;
  overview: NotionalPoolOverview | null;
  errorMessage?: string;
}

/**
 * Month-to-date/year-to-date interest and current/MTD-average balance for `currency`, via
 * `notional_pool_overview`. Never throws — every failure mode comes back as
 * `status !== 'live'` with an honest message.
 *
 * `balance.monthToDateAverage` is an average per account-day, not the average of the
 * provider's total daily balance — see the tool's own description for why that understates a
 * multi-account provider. Not corrected here; surfaced as Treasury computes it.
 */
export async function getTreasuryNotionalPoolOverview(email: string, currency: string): Promise<NotionalPoolOverviewResult> {
  const outcome = await withTreasuryClient(email, '[treasury/notional-pool]', client =>
    client.callTool('notional_pool_overview', { currency }, notionalPoolOverviewSchema),
  );

  if (outcome.status !== 'live') {
    return { status: outcome.status, overview: null, errorMessage: outcome.status === 'error' ? outcome.errorMessage : undefined };
  }

  return { status: 'live', overview: outcome.data.overview };
}

// --- notional_pool_daily_metrics ----------------------------------------------------------

const notionalPoolCellValueSchema = z.object({ value: z.number(), previousPeriodPercentageChange: z.number() });

const notionalPoolDailyRecordSchema = z.object({
  date: z.string(),
  npTotalUsd: z.number(),
  currencies: z.record(z.string(), z.object({ jpmorgan: notionalPoolCellValueSchema, citi: notionalPoolCellValueSchema })),
});

export const notionalPoolDailyMetricsSchema = z.object({
  records: z.array(notionalPoolDailyRecordSchema),
  meta: z.object({
    // Treasury's own INotionalPoolDailyMetricsResult types this as `string` — an odd choice this
    // connector never relies on (only meta.hasMore is read below) — so it's accepted as either
    // shape rather than hard-failing every call if that turns out to be a source-level quirk
    // rather than the real wire format.
    perPage: z.union([z.string(), z.number()]),
    lastId: z.string().nullable(),
    hasMore: z.boolean(),
    currencies: z.array(z.string()),
  }),
  nextCursor: z.string().nullable(),
  populated: z.object({ currencies: z.record(z.string(), z.object({ code: z.string(), symbol: z.string().nullable() })) }),
  summary: z.string().optional(),
});

export type NotionalPoolDailyRecord = z.infer<typeof notionalPoolDailyRecordSchema>;

export interface NotionalPoolDailyMetricsFilters {
  currency?: string[];
  provider?: ('jpmorgan' | 'citi')[];
  granularity?: 'daily' | 'monthly';
  perPage?: number;
  afterCursor?: string;
}

export interface NotionalPoolDailyMetricsResult {
  status: NotionalPoolStatus;
  records: NotionalPoolDailyRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  errorMessage?: string;
}

/**
 * Daily or monthly notional pool interest/balance metrics for `dateFrom`..`dateTo`, via
 * `notional_pool_daily_metrics`. Same never-throws contract as the other functions here.
 */
export async function getTreasuryNotionalPoolDailyMetrics(
  email: string,
  metric: 'interest' | 'balance',
  dateFrom: string,
  dateTo: string,
  filters: NotionalPoolDailyMetricsFilters = {},
): Promise<NotionalPoolDailyMetricsResult> {
  const outcome = await withTreasuryClient(email, '[treasury/notional-pool]', client =>
    client.callTool('notional_pool_daily_metrics', { metric, dateFrom, dateTo, ...filters }, notionalPoolDailyMetricsSchema),
  );

  if (outcome.status !== 'live') {
    return {
      status: outcome.status,
      records: [],
      nextCursor: null,
      hasMore: false,
      errorMessage: outcome.status === 'error' ? outcome.errorMessage : undefined,
    };
  }

  return { status: 'live', records: outcome.data.records, nextCursor: outcome.data.nextCursor, hasMore: outcome.data.meta.hasMore };
}

// --- notional_pool_rate_snapshot ----------------------------------------------------------

const rateSnapshotRecordSchema = z.object({
  id: z.string(),
  provider: z.string(),
  currency: z.string(),
  latestRate: z.number().nullable(),
  latestDate: z.string(),
  percentageChange: z.number(),
  previousRate: z.number().nullable(),
  previousDate: z.string().nullable(),
});

export const notionalPoolRateSnapshotSchema = z.object({
  records: z.array(rateSnapshotRecordSchema),
  total: z.number(),
  summary: z.string().optional(),
});

export type NotionalPoolRateSnapshotRecord = z.infer<typeof rateSnapshotRecordSchema>;

export interface NotionalPoolRateSnapshotResult {
  status: NotionalPoolStatus;
  records: NotionalPoolRateSnapshotRecord[];
  errorMessage?: string;
}

/**
 * Latest notional pool interest rate per provider (market/Refinitiv, JPMorgan, Citi) for
 * `currency`, via `notional_pool_rate_snapshot`. Each record already carries its own
 * `provider` and `latestDate` — the rate-provenance rule (`.claude/rules/div/standards.md`)
 * is satisfied by the tool's own shape, not by anything added here.
 */
export async function getTreasuryNotionalPoolRateSnapshot(email: string, currency: string): Promise<NotionalPoolRateSnapshotResult> {
  const outcome = await withTreasuryClient(email, '[treasury/notional-pool]', client =>
    client.callTool('notional_pool_rate_snapshot', { currency }, notionalPoolRateSnapshotSchema),
  );

  if (outcome.status !== 'live') {
    return { status: outcome.status, records: [], errorMessage: outcome.status === 'error' ? outcome.errorMessage : undefined };
  }

  return { status: 'live', records: outcome.data.records };
}

// --- notional_pool_rate_history -----------------------------------------------------------

const rateHistoryEntrySchema = z.object({
  market: z.number().nullable(),
  jpmorgan: z.number().nullable(),
  citi: z.number().nullable(),
});

export const notionalPoolRateHistorySchema = z.object({
  ratesByDate: z.record(z.string(), rateHistoryEntrySchema),
  meta: z.object({
    currency: z.string(),
    fromDate: z.string(),
    toDate: z.string(),
    interval: z.number(),
    pointCount: z.number(),
  }),
  summary: z.string().optional(),
});

export type NotionalPoolRateHistoryEntry = z.infer<typeof rateHistoryEntrySchema>;

export interface NotionalPoolRateHistoryResult {
  status: NotionalPoolStatus;
  /** Date (YYYY-MM-DD) -> per-provider rate for that sampled date. */
  ratesByDate: Record<string, NotionalPoolRateHistoryEntry>;
  errorMessage?: string;
}

/**
 * Notional pool interest rate history for `currency` across `fromDate`..`toDate`, sampled
 * every `intervalDays`, via `notional_pool_rate_history`. Same never-throws contract as the
 * other functions here.
 */
export async function getTreasuryNotionalPoolRateHistory(
  email: string,
  currency: string,
  fromDate: string,
  toDate: string,
  intervalDays: number,
): Promise<NotionalPoolRateHistoryResult> {
  const outcome = await withTreasuryClient(email, '[treasury/notional-pool]', client =>
    client.callTool('notional_pool_rate_history', { currency, fromDate, toDate, interval: intervalDays }, notionalPoolRateHistorySchema),
  );

  if (outcome.status !== 'live') {
    return { status: outcome.status, ratesByDate: {}, errorMessage: outcome.status === 'error' ? outcome.errorMessage : undefined };
  }

  return { status: 'live', ratesByDate: outcome.data.ratesByDate };
}
