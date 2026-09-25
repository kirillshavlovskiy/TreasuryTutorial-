import { z } from 'zod';
import { withTreasuryClient } from '@/lib/treasury/mcp-client';

/**
 * `fx_order_blotter_search` via the Treasury Finance MCP — full-filter-parity FX order search
 * (fx_order_search plus id/amount-range/creator/country/orderType/option/invoice/withdrawal
 * filters). Requires `fx_orders: READ`. Chain a returned order's `id` into `fx_order_detail`
 * for full detail (not wired here — out of scope for this connector).
 *
 * The schema below is read directly from treasury's
 * app/src/mcp/tools/fx_trading/fx_order_blotter_search.ts (the FXOrder.findAll `attributes`
 * list and its Currency/FinancialAccount `include`s), not inferred from the tool description —
 * this is deployed and live, not a pending/unvalidated shape.
 */

const amountLike = z.union([z.string(), z.number()]);

export type FxOrderBlotterStatus = 'not_connected' | 'live' | 'reauth_required' | 'error';

const fxOrderRowSchema = z.object({
  id: z.number(),
  status: z.string(),
  sourceAmount: amountLike.nullable(),
  destinationAmount: amountLike.nullable(),
  exchangeRate: amountLike.nullable(),
  tradingPlatform: z.string().nullable(),
  tradeType: z.string().nullable(),
  kind: z.string(),
  product: z.string(),
  region: z.string().nullable(),
  country: z.string().nullable(),
  cycle: z.string().nullable(),
  informationalStatus: z.string().nullable(),
  tradeDate: z.string().nullable(),
  valueDate: z.string().nullable(),
  createdAt: z.string(),
  creatorType: z.string().nullable(),
  CreatorId: z.number().nullable(),
  withdrawalId: z.number().nullable(),
  invoiceId: z.number().nullable(),
  orderType: z.string().nullable(),
  fixingDate: z.string().nullable(),
  fixingRate: amountLike.nullable(),
  farLegSourceAmount: amountLike.nullable(),
  farLegSourceCurrencyId: z.number().nullable(),
  farLegSourceAccountId: z.number().nullable(),
  farLegDestinationAmount: amountLike.nullable(),
  farLegDestinationCurrencyId: z.number().nullable(),
  farLegDestinationAccountId: z.number().nullable(),
  farLegExchangeRate: amountLike.nullable(),
  farLegFeeAmount: amountLike.nullable(),
  farLegFeeCurrencyId: z.number().nullable(),
  farLegTradeDate: z.string().nullable(),
  valueDateFarLeg: z.string().nullable(),
  premiumAmount: amountLike.nullable(),
  premiumCurrencyId: z.number().nullable(),
  optionLifecycleStatus: z.string().nullable(),
  optionType: z.string().nullable(),
  isSettled: z.boolean(),
  isAggregated: z.boolean(),
  SourceCurrency: z.object({ code: z.string() }).nullable().optional(),
  DestinationCurrency: z.object({ code: z.string() }).nullable().optional(),
  SourceFinancialAccount: z.object({ id: z.number(), name: z.string() }).nullable().optional(),
  DestinationFinancialAccount: z.object({ id: z.number(), name: z.string() }).nullable().optional(),
});

export const fxOrderBlotterSearchSchema = z.object({
  count: z.number(),
  nextCursor: z.string().nullable(),
  fxOrders: z.array(fxOrderRowSchema),
  summary: z.string().optional(),
});

export type FxOrderBlotterRow = z.infer<typeof fxOrderRowSchema>;

/** Mirrors the tool's own parameter table — at least one of these must be set, or the tool itself errors. */
export interface FxOrderBlotterFilters {
  id?: number;
  status?: string;
  sourceCurrency?: string;
  destinationCurrency?: string;
  tradingPlatform?: string;
  region?: string;
  product?: string;
  kind?: string;
  tradeType?: string;
  tradeDateFrom?: string;
  tradeDateTo?: string;
  valueDateFrom?: string;
  valueDateTo?: string;
  cycle?: string;
  informationalStatus?: string;
  sourceAmountMin?: number;
  sourceAmountMax?: number;
  destinationAmountMin?: number;
  destinationAmountMax?: number;
  CreatorId?: number;
  creatorType?: string;
  country?: string;
  orderType?: string;
  premiumAmountMin?: number;
  premiumAmountMax?: number;
  premiumCurrencyId?: number;
  optionLifecycleStatus?: string;
  optionType?: string;
  invoiceId?: number;
  withdrawalId?: number;
  isAggregated?: boolean;
  isSettled?: boolean;
  sortBy?: 'id' | 'tradeDate' | 'valueDate' | 'createdAt';
  direction?: 'ASC' | 'DESC';
  limit?: number;
  afterCursor?: string;
}

export interface FxOrderBlotterResult {
  status: FxOrderBlotterStatus;
  /** null on a non-'live' status — never a fabricated 0, which reads as a real "no orders match" answer. */
  count: number | null;
  nextCursor: string | null;
  orders: FxOrderBlotterRow[];
  /** Present only when status is 'error' — safe to show, never includes token/secret material. */
  errorMessage?: string;
}

/** Shapes a result set rather than filtering one — excluded from `hasFilter` below, same as the tool's own check. */
const PAGINATION_AND_SORT_KEYS = new Set<keyof FxOrderBlotterFilters>(['sortBy', 'direction', 'limit', 'afterCursor']);

/**
 * Mirrors the tool's own `hasFilter` guard (app/src/mcp/tools/fx_trading/fx_order_blotter_search.ts)
 * so an empty filter object is rejected locally — same reasoning as `parsePairsInput` in
 * fx-rates.ts: "a caller finds out from this app rather than from an opaque Treasury 400."
 * Deliberately keyed off `Object.keys(filters)` rather than a hand-maintained field list: a new
 * field added to `FxOrderBlotterFilters` is automatically treated as a real filter (the tool's own
 * intent — "filter" means "not sort/pagination") without this function needing a matching edit.
 */
function hasFilter(filters: FxOrderBlotterFilters): boolean {
  return Object.entries(filters).some(
    ([key, value]) => !PAGINATION_AND_SORT_KEYS.has(key as keyof FxOrderBlotterFilters) && value !== undefined,
  );
}

/**
 * Searches FX orders via `fx_order_blotter_search`, using the caller's own Treasury OAuth link.
 * Never throws — every failure mode comes back as `status !== 'live'` with an honest message,
 * the same contract as `getTreasuryFxRatesForUser`.
 */
export async function searchTreasuryFxOrderBlotter(email: string, filters: FxOrderBlotterFilters): Promise<FxOrderBlotterResult> {
  if (!hasFilter(filters)) {
    return {
      status: 'error',
      count: null,
      nextCursor: null,
      orders: [],
      errorMessage: 'Provide at least one filter (id, status, sourceCurrency, destinationCurrency, tradingPlatform, region, product, kind, tradeType, dates, cycle, informationalStatus, amount ranges, CreatorId, creatorType, country, orderType, premium fields, optionLifecycleStatus, optionType, invoiceId, withdrawalId, isAggregated, or isSettled).',
    };
  }

  const outcome = await withTreasuryClient(email, '[treasury/fx-order-blotter]', client =>
    client.callTool('fx_order_blotter_search', { ...filters }, fxOrderBlotterSearchSchema),
  );

  if (outcome.status !== 'live') {
    return {
      status: outcome.status,
      count: null,
      nextCursor: null,
      orders: [],
      errorMessage: outcome.status === 'error' ? outcome.errorMessage : undefined,
    };
  }

  return { status: 'live', count: outcome.data.count, nextCursor: outcome.data.nextCursor, orders: outcome.data.fxOrders };
}
