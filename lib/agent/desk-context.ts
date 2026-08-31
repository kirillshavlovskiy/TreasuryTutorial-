/**
 * Serializable snapshot of the Workbench FX desk that travels with each AI
 * Agent chat request. All desk math (VaR / Cash Carry / CFaR) is pure
 * TypeScript, so the server-side agent tools re-run the exact engines the
 * tabs use against this snapshot — no separate model, no state duplication.
 */

import type { RowState } from '@/lib/fx-buffer';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import type { ForecastProfileState } from '@/lib/forecast-profile';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import type {
  EntityHedgeBook,
  HedgeTicket,
  PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import type { VarSetup } from '@/lib/test-mode/var-setup';

export type AgentSurface = 'workbench' | 'sandbox';

export interface DeskContextSnapshot {
  entityName: string;
  dashboardName: string;
  /** Seed risk bars (pre live-book overlay) — tools overlay bookRows on top. */
  risk: CurrencyRiskRow[];
  varSetup: VarSetup;
  hedgeRatios: Record<string, number>;
  bookedHedges: HedgeTicket[];
  preparedByCcy: Record<string, PreparedHedgeProfile>;
  marketRatesByCcy: Record<string, FxMarketRatesBundle>;
  /** Live FX Risk table rows (edited stock/flows), when the tab has produced them. */
  bookRows: RowState[];
  forecastProfile: ForecastProfileState | null;
  /** Entity id — market-rate resolution scope. */
  ratesScopeId: string;
  /** Which product surface shipped this snapshot (prompt + chat-key namespace). */
  surface?: AgentSurface;
}

/** One user-attached raw data file, parsed client-side into a small table. */
export interface AttachedDataFile {
  name: string;
  kind: 'csv' | 'xlsx';
  sheetName?: string;
  headers: string[];
  /** Row-major cell values; truncated to MAX_ATTACHED_ROWS. */
  rows: (string | number | null)[][];
  /** Row count before truncation. */
  totalRows: number;
}

/** Cap on rows shipped to the model per file — keeps free-tier tokens sane. */
export const MAX_ATTACHED_ROWS = 200;

/** Request body for POST /api/agent/chat (alongside UI messages). */
export interface AgentChatBody {
  deskContext: DeskContextSnapshot;
  attachedData: AttachedDataFile[];
}

export function buildDeskContextSnapshot(input: {
  entityName: string;
  dashboardName: string;
  risk: CurrencyRiskRow[];
  varSetup: VarSetup;
  hedgeBook: EntityHedgeBook;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  ratesScopeId: string;
  surface?: AgentSurface;
}): DeskContextSnapshot {
  return {
    entityName: input.entityName,
    dashboardName: input.dashboardName,
    risk: input.risk,
    varSetup: input.varSetup,
    hedgeRatios: input.hedgeBook.hedgeRatios ?? {},
    bookedHedges: input.hedgeBook.bookedHedges ?? [],
    preparedByCcy: input.hedgeBook.preparedByCcy ?? {},
    marketRatesByCcy: input.hedgeBook.marketRatesByCcy ?? {},
    bookRows: [...(input.bookRows ?? [])],
    forecastProfile: input.forecastProfile ?? null,
    ratesScopeId: input.ratesScopeId,
    surface: input.surface ?? 'workbench',
  };
}
