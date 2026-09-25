import { z } from 'zod';
import { withTreasuryClient } from '@/lib/treasury/mcp-client';

/**
 * `fx_pl_inventory_overview` and `fx_pl_inventory_by_currency` via the Treasury Finance MCP —
 * FX order P&L inventory (cumulative amount, USD historical vs current value, unrealized P&L,
 * average rate, trade count), backed by the `fx_orders_pl_inventory` snapshot table. Requires
 * `fx_orders_pl_inventory: READ`.
 *
 * Row shape below is read directly from treasury's
 * app/src/services/fx_order_pl/fx_order_pl_service.ts (`getFXOrdersPLInventoryOverview` /
 * `getFXOrdersPLInventoryForCurrency`), not inferred from the tool description. `amount`,
 * `avgRate` and `USDRateCurrentValue` are Big.js instances there — Big.js's own `toJSON()`
 * serializes them as strings, so they arrive here as strings even though `USDAmountHistorical`,
 * `USDAmountCurrentValue`, `numberOfTrades`, `pnlAmount` and `premiumPnlAmount` are already
 * plain numbers (`.toNumber()` was called on those before the response was built).
 */

const amountLike = z.union([z.string(), z.number()]);

export type FxPlInventoryStatus = 'not_connected' | 'live' | 'reauth_required' | 'error';

const plInventoryRowSchema = z.object({
  currency: z.string(),
  products: z.array(z.string()),
  amount: amountLike,
  USDAmountHistorical: z.number(),
  USDAmountCurrentValue: z.number().nullable(),
  numberOfTrades: z.number(),
  pnlAmount: z.number(),
  avgRate: amountLike,
  USDRateCurrentValue: amountLike,
  premiumPnlAmount: z.number(),
});

export type FxPlInventoryRow = z.infer<typeof plInventoryRowSchema>;

export const fxPlInventoryOverviewSchema = z.object({
  pnlAmount: z.number(),
  numberOfTradesTotal: z.number(),
  PLInventory: z.array(plInventoryRowSchema),
  dateRange: z.object({ fromDate: z.string(), toDate: z.string() }),
  summary: z.string().optional(),
});

export const fxPlInventoryByCurrencySchema = z.object({
  pnlAmount: z.number(),
  numberOfTradesTotal: z.number(),
  PLInventory: z.array(plInventoryRowSchema),
  dateRange: z.object({ fromDate: z.string(), toDate: z.string() }),
  currency: z.string(),
  summary: z.string().optional(),
});

/** Shared across both tools — mirrors their identical filter parameter tables. */
export interface FxPlInventoryFilters {
  products?: string[];
  creatorTypes?: string[];
  tradingPlatforms?: string[];
  kinds?: string[];
  currencyPairs?: string[];
  cycle?: string[];
  tradeTypes?: string[];
  isAggregated?: boolean;
  isSettled?: boolean;
  useHistoricalInventory?: boolean;
}

export interface FxPlInventoryOverviewResult {
  status: FxPlInventoryStatus;
  /** null on a non-'live' status — never a fabricated 0, which is itself a plausible P&L value. */
  pnlAmount: number | null;
  numberOfTradesTotal: number | null;
  inventory: FxPlInventoryRow[];
  /** The range actually reflected in `inventory`/`pnlAmount` — Treasury may clamp it; see the tool's own echo of it. Null on a non-'live' status. */
  dateRange: { fromDate: string; toDate: string } | null;
  errorMessage?: string;
}

export interface FxPlInventoryByCurrencyResult extends FxPlInventoryOverviewResult {
  currency: string;
}

/**
 * Aggregate FX order P&L inventory across all currencies for `fromDate`..`toDate`, via
 * `fx_pl_inventory_overview`. Never throws — every failure mode comes back as
 * `status !== 'live'` with an honest message, the same contract as `getTreasuryFxRatesForUser`.
 */
export async function getTreasuryFxPlInventoryOverview(
  email: string,
  fromDate: string,
  toDate: string,
  filters: FxPlInventoryFilters = {},
): Promise<FxPlInventoryOverviewResult> {
  const outcome = await withTreasuryClient(email, '[treasury/fx-pl-inventory]', client =>
    client.callTool('fx_pl_inventory_overview', { fromDate, toDate, ...filters }, fxPlInventoryOverviewSchema),
  );

  if (outcome.status !== 'live') {
    return {
      status: outcome.status,
      pnlAmount: null,
      numberOfTradesTotal: null,
      inventory: [],
      dateRange: null,
      errorMessage: outcome.status === 'error' ? outcome.errorMessage : undefined,
    };
  }

  return {
    status: 'live',
    pnlAmount: outcome.data.pnlAmount,
    numberOfTradesTotal: outcome.data.numberOfTradesTotal,
    inventory: outcome.data.PLInventory,
    dateRange: outcome.data.dateRange,
  };
}

/**
 * FX order P&L inventory for a single `currency` over `fromDate`..`toDate`, via
 * `fx_pl_inventory_by_currency`. Same never-throws contract as the overview above.
 */
export async function getTreasuryFxPlInventoryByCurrency(
  email: string,
  fromDate: string,
  toDate: string,
  currency: string,
  filters: FxPlInventoryFilters = {},
): Promise<FxPlInventoryByCurrencyResult> {
  // Normalized once, up front, and reused everywhere (request, error fallback) — the tool's own
  // schema uppercases `currency` too, but doing it here as well keeps what this function sends,
  // reports on error, and reports on success all in agreement (they previously weren't).
  const normalizedCurrency = currency.toUpperCase();

  const outcome = await withTreasuryClient(email, '[treasury/fx-pl-inventory]', client =>
    client.callTool('fx_pl_inventory_by_currency', { fromDate, toDate, currency: normalizedCurrency, ...filters }, fxPlInventoryByCurrencySchema),
  );

  if (outcome.status !== 'live') {
    return {
      status: outcome.status,
      pnlAmount: null,
      numberOfTradesTotal: null,
      inventory: [],
      dateRange: null,
      currency: normalizedCurrency,
      errorMessage: outcome.status === 'error' ? outcome.errorMessage : undefined,
    };
  }

  return {
    status: 'live',
    pnlAmount: outcome.data.pnlAmount,
    numberOfTradesTotal: outcome.data.numberOfTradesTotal,
    inventory: outcome.data.PLInventory,
    dateRange: outcome.data.dateRange,
    // `normalizedCurrency`, not `outcome.data.currency`: the tool's own schema uppercases too, so
    // in practice they agree, but reporting the one value this function actually sent removes any
    // dependence on that agreement holding, and matches the currency on every other branch.
    currency: normalizedCurrency,
  };
}
