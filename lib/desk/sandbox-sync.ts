import type { DeskPutInput } from '@/lib/desk/types';
import type { TestSandboxState } from '@/lib/test-mode/types';
import { parseVarSetup } from '@/lib/test-mode/var-setup';

/** Split a sandbox blob into the normalized desk-table writes. */
export function snapshotsFromSandbox(state: TestSandboxState): DeskPutInput[] {
  const puts: DeskPutInput[] = [{ workspace: state.workspace }];

  for (const entity of state.workspace.entities) {
    for (const dash of entity.dashboards) {
      const liq = dash.forecastProfile?.liquidity;
      puts.push({
        liquidity: {
          dashboardId: dash.id,
          entityId: entity.id,
          forecastProfile: dash.forecastProfile ?? null,
          timing: dash.timing ?? null,
          sizingBasis: liq?.sizingBasis ?? null,
          bookingMode: liq?.bookingMode ?? null,
        },
      });
      if (dash.formulas && Object.keys(dash.formulas).length > 0) {
        puts.push({
          fxBook: {
            dashboardId: dash.id,
            entityId: entity.id,
            rows: [],
            formulas: dash.formulas,
          },
        });
      }
    }
  }

  const varSetup = parseVarSetup(state.answers);
  const firstDash = state.workspace.entities[0]?.dashboards[0];
  if (varSetup && firstDash) {
    puts.push({
      analytics: {
        dashboardId: firstDash.id,
        entityId: state.workspace.entities[0]?.id ?? null,
        varSetup,
      },
    });
  }

  for (const [scopeId, book] of Object.entries(state.hedgesByEntityId ?? {})) {
    puts.push({ hedge: { scopeId, book } });
    if (firstDash && (book.preparedByCcy || book.carrySessionsByCcy || book.marketRatesByCcy)) {
      puts.push({
        analytics: {
          dashboardId: firstDash.id,
          entityId: scopeId === '__group__' ? null : scopeId,
          varSetup: varSetup ?? undefined,
          preparedByCcy: book.preparedByCcy ?? null,
          carrySessions: book.carrySessionsByCcy ?? null,
          marketRates: book.marketRatesByCcy ?? null,
        },
      });
    }
  }

  return puts;
}
