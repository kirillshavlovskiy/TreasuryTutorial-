import { z } from 'zod';
import { withTreasuryClient } from '@/lib/treasury/mcp-client';

/**
 * `get_financial_account` and `search_financial_accounts_advanced` via the Treasury Finance
 * MCP. Both require `financial_accounts: READ`. Neither ever returns bank identifiers
 * (accountNumber/routingNumber/IBAN/SWIFT/ABA) — that's the tool's own design, not filtered
 * here.
 *
 * Response shapes below are read directly from treasury's
 * app/src/mcp/tools/accounts/get_financial_account.ts and
 * app/src/mcp/tools/accounts/search_financial_accounts_advanced.ts, not inferred from the
 * tool descriptions.
 */

export type TreasuryAccountsStatus = 'not_connected' | 'live' | 'reauth_required' | 'error';

const institutionRefSchema = z.object({ id: z.number(), legalName: z.string() }).nullable();
const currencyRefSchema = z.object({ id: z.number(), code: z.string(), symbol: z.string().nullable() }).nullable();

const financialAccountDetailSchema = z.object({
  id: z.number(),
  name: z.string(),
  createdAt: z.string(),
  financialInstitutionId: z.number().nullable(),
  deelLegalEntityId: z.number().nullable(),
  currencyId: z.number(),
  openingDate: z.string().nullable(),
  netsuiteAccountId: z.number().nullable(),
  accountUse: z.string(),
  accountType: z.string(),
  purpose: z.string().nullable(),
  accountStatus: z.string(),
  closingDate: z.string().nullable(),
  fundingDatesInfo: z.array(z.unknown()).nullable(),
  beforeDueDays: z.number().nullable(),
  entityRegion: z.string().nullable(),
  safeguardingRegion: z.string().nullable(),
  api: z.array(z.string()).nullable(),
  accountSigners: z.array(z.object({ user: z.unknown(), type: z.unknown() })).nullable(),
  accountPortalUsers: z.array(z.object({ user: z.unknown(), type: z.unknown() })).nullable(),
  paymentMethodUUID: z.string().nullable(),
  isAllowedACHTransferSource: z.boolean(),
  isFavorite: z.boolean(),
  financialInstitution: institutionRefSchema,
  currency: currencyRefSchema,
  deelLegalEntity: z.object({ id: z.number(), legalName: z.string(), displayName: z.string() }).nullable(),
});

export const getFinancialAccountSchema = z.object({
  account: financialAccountDetailSchema,
  summary: z.string().optional(),
});

export type TreasuryFinancialAccountDetail = z.infer<typeof financialAccountDetailSchema>;

export interface GetFinancialAccountResult {
  status: TreasuryAccountsStatus;
  account: TreasuryFinancialAccountDetail | null;
  errorMessage?: string;
}

/**
 * Full single-record detail for a Treasury FinancialAccount, via `get_financial_account`.
 * Never throws — every failure mode (including "not found", which the tool itself reports as
 * a tool error) comes back as `status !== 'live'` with an honest message.
 */
export async function getTreasuryFinancialAccount(email: string, financialAccountId: number): Promise<GetFinancialAccountResult> {
  const outcome = await withTreasuryClient(email, '[treasury/accounts]', client =>
    client.callTool('get_financial_account', { financialAccountId }, getFinancialAccountSchema),
  );

  if (outcome.status !== 'live') {
    return { status: outcome.status, account: null, errorMessage: outcome.status === 'error' ? outcome.errorMessage : undefined };
  }

  return { status: 'live', account: outcome.data.account };
}

const searchAccountRowSchema = z.object({
  id: z.number(),
  name: z.string(),
  accountStatus: z.string().nullable(),
  accountUse: z.string(),
  accountType: z.string(),
  subRegion: z.string().nullable(),
  deelLegalEntityId: z.number().nullable(),
  currencyId: z.number(),
  financialInstitutionId: z.number().nullable(),
  yieldRate: z.union([z.string(), z.number()]).nullable(),
  netsuiteAccountId: z.number().nullable(),
  openingDate: z.string().nullable(),
  closingDate: z.string().nullable(),
  masterFinancialAccountId: z.number().nullable(),
  financialInstitution: institutionRefSchema,
  currency: currencyRefSchema,
  deelLegalEntity: z.object({ id: z.number(), legalName: z.string(), country: z.string().nullable(), region: z.string().nullable() }).nullable(),
});

export type TreasuryAccountSearchRow = z.infer<typeof searchAccountRowSchema>;

export const searchFinancialAccountsAdvancedSchema = z.object({
  count: z.number(),
  total: z.number(),
  page: z.number(),
  perPage: z.number(),
  accounts: z.array(searchAccountRowSchema),
  summary: z.string().optional(),
});

/** Mirrors the tool's own parameter table. */
export interface SearchFinancialAccountsAdvancedFilters {
  name?: string;
  id?: number;
  note?: string;
  accountStatus?: string;
  accountUse?: string;
  accountType?: string;
  subRegion?: string;
  currencyId?: number;
  financialInstitutionId?: number;
  institutionCountry?: string[];
  entityCountry?: string[];
  entityRegion?: string[];
  deelLegalEntityId?: number;
  isDeelInc?: boolean;
  masterFinancialAccountId?: number;
  deelClientLegalEntityOrProfileName?: string;
  assignedUserId?: number;
  assignedRole?: string;
  assignedRoleExcludes?: string;
  yieldRate?: ('hasYield' | 'noYield' | 'notSpecified')[];
  page?: number;
  perPage?: number;
  sortBy?: 'name' | 'id' | 'createdAt' | 'openingDate' | 'accountStatus' | 'yieldRate';
  direction?: 'ASC' | 'DESC';
}

export interface SearchFinancialAccountsAdvancedResult {
  status: TreasuryAccountsStatus;
  /** null on a non-'live' status — never a fabricated 0, which reads as a real "no accounts match" answer. */
  count: number | null;
  total: number | null;
  page: number;
  perPage: number;
  accounts: TreasuryAccountSearchRow[];
  errorMessage?: string;
}

/**
 * Multi-filter search over FinancialAccount records, via `search_financial_accounts_advanced`.
 * Never throws — same never-throws contract as `getTreasuryFinancialAccount`.
 */
export async function searchTreasuryFinancialAccountsAdvanced(
  email: string,
  filters: SearchFinancialAccountsAdvancedFilters = {},
): Promise<SearchFinancialAccountsAdvancedResult> {
  const outcome = await withTreasuryClient(email, '[treasury/accounts]', client =>
    client.callTool('search_financial_accounts_advanced', { ...filters }, searchFinancialAccountsAdvancedSchema),
  );

  if (outcome.status !== 'live') {
    // 1 / 50 mirror the tool's own defaults (`const page = args.page ?? 1`, `const perPage =
    // args.perPage ?? 50` in search_financial_accounts_advanced.ts) — not invented here, so a
    // failed call still echoes the page/perPage the caller would have gotten back had it succeeded.
    return {
      status: outcome.status,
      count: null,
      total: null,
      page: filters.page ?? 1,
      perPage: filters.perPage ?? 50,
      accounts: [],
      errorMessage: outcome.status === 'error' ? outcome.errorMessage : undefined,
    };
  }

  return {
    status: 'live',
    count: outcome.data.count,
    total: outcome.data.total,
    page: outcome.data.page,
    perPage: outcome.data.perPage,
    accounts: outcome.data.accounts,
  };
}
