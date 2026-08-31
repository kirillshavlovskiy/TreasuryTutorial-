import type { ForecastProfileState } from '@/lib/forecast-profile';
import type { RowState, SharedGlobals, UsdParams } from '@/lib/fx-buffer';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import type {
  CarryProfileSessionV1,
  EntityHedgeBook,
  PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import type { VarSetup } from '@/lib/test-mode/var-setup';
import type { TimingProfile, Workspace } from '@/lib/workspace-store';

export type DeskModule = 'workspace' | 'fx' | 'liquidity' | 'analytics' | 'hedging';

export const DESK_STATE_VERSION = 1;
export const WORKBENCH_DESK_SCOPE = 'workbench';

export function deskScopeForTask(taskId: string): string {
  return `task:${taskId.trim() || '01'}`;
}

export interface DeskFxBookInput {
  dashboardId: string;
  entityId?: string | null;
  rows: RowState[];
  usdCash?: number | null;
  usdNonLpCash?: number | null;
  usdParams?: UsdParams | null;
  shared?: SharedGlobals | null;
  activeLayers?: string[] | null;
  policyVar?: number | null;
  formulas?: Record<string, string> | null;
}

export interface DeskLiquidityInput {
  dashboardId: string;
  entityId?: string | null;
  forecastProfile?: ForecastProfileState | null;
  timing?: TimingProfile | null;
  sizingBasis?: string | null;
  bookingMode?: string | null;
  activeLayers?: string[] | null;
}

export interface DeskAnalyticsInput {
  dashboardId: string;
  entityId?: string | null;
  varSetup?: VarSetup | null;
  preparedByCcy?: Record<string, PreparedHedgeProfile> | null;
  carrySessions?: Record<string, CarryProfileSessionV1> | null;
  marketRates?: Record<string, FxMarketRatesBundle> | null;
}

export interface DeskHedgeInput {
  scopeId: string;
  book: EntityHedgeBook;
}

export interface DeskActionInput {
  module: DeskModule;
  action: string;
  dashboardId?: string | null;
  scopeId?: string | null;
  payload?: unknown;
}

export interface DeskPutInput {
  workspace?: Workspace;
  fxBook?: DeskFxBookInput;
  liquidity?: DeskLiquidityInput;
  analytics?: DeskAnalyticsInput;
  hedge?: DeskHedgeInput;
  action?: DeskActionInput;
}

export interface DeskStateSnapshot {
  scope: string;
  workspace: Workspace | null;
  fxBooks: Array<{
    dashboardId: string;
    entityId: string | null;
    rows: RowState[];
    usdCash: number | null;
    usdNonLpCash: number | null;
    usdParams: UsdParams | null;
    shared: SharedGlobals | null;
    activeLayers: string[] | null;
    policyVar: number | null;
    formulas: Record<string, string> | null;
    updatedAt: string;
  }>;
  liquidity: Array<{
    dashboardId: string;
    entityId: string | null;
    forecastProfile: ForecastProfileState | null;
    timing: TimingProfile | null;
    sizingBasis: string | null;
    bookingMode: string | null;
    activeLayers: string[] | null;
    updatedAt: string;
  }>;
  analytics: Array<{
    dashboardId: string;
    entityId: string | null;
    varSetup: VarSetup | null;
    preparedByCcy: Record<string, PreparedHedgeProfile> | null;
    carrySessions: Record<string, CarryProfileSessionV1> | null;
    marketRates: Record<string, FxMarketRatesBundle> | null;
    updatedAt: string;
  }>;
  hedges: Record<string, EntityHedgeBook>;
  storageEnv: 'uat' | 'production';
  persistent: boolean;
}
