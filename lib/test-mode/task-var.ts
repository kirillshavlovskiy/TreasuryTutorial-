import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
import {
  DEFAULT_VAR_SETUP,
  computeParametricVarUsdM,
  type VarExposureBasis,
  type VarSetup,
  volForHorizon,
} from '@/lib/test-mode/var-setup';
import type { VarConfidencePct } from '@/lib/test-mode/var-confidence';
import type { LadderBar } from '@/lib/test-mode/types';

export interface VarResult {
  ccy: string;
  /** Exposure used (local CCY millions). */
  exposureLocalM: number;
  exposureBasis: VarExposureBasis;
  spotUsd: number;
  monthlyVol: number;
  horizonVol: number;
  z: number;
  confidencePct: VarConfidencePct;
  horizon: VarSetup['horizon'];
  /** VaR in USD millions at the chosen setup. */
  varUsdM: number;
  horizonLabel: string;
  confidenceLabel: string;
  /** @deprecated use `z` */
  z95: number;
}

function basisFromLegacy(
  basis: 'stock' | 'threeMonthAvg' | VarExposureBasis,
): VarExposureBasis {
  if (basis === 'threeMonthAvg' || basis === 'avgBuildup') return 'avgBuildup';
  return 'stock';
}

/**
 * Parametric VaR for a ladder bar under an Analytics setup.
 * Legacy `(bar, 'stock'|'threeMonthAvg', confidence)` still works.
 */
export function computeTaskVar(
  bar: LadderBar,
  basisOrSetup: 'stock' | 'threeMonthAvg' | VarExposureBasis | VarSetup = 'stock',
  confidencePct: VarConfidencePct = 95,
): VarResult {
  const setup: VarSetup =
    typeof basisOrSetup === 'object'
      ? basisOrSetup
      : {
          ...DEFAULT_VAR_SETUP,
          exposureBasis: basisFromLegacy(basisOrSetup),
          confidencePct,
        };

  const exposureLocalM =
    setup.exposureBasis === 'avgBuildup' ? bar.avg3mM : bar.stockNetM;
  const spotUsd = NORDTECH_VAR.spotUsd[bar.ccy] ?? 1;
  const horizonVol = volForHorizon(setup.horizon);
  const varUsdM = computeParametricVarUsdM(exposureLocalM, bar.ccy, setup);
  const z = varUsdM / (Math.abs(exposureLocalM) * spotUsd * horizonVol || 1);

  return {
    ccy: bar.ccy,
    exposureLocalM,
    exposureBasis: setup.exposureBasis,
    spotUsd,
    monthlyVol: NORDTECH_VAR.monthlyVol,
    horizonVol,
    z: Number.isFinite(z) ? z : NORDTECH_VAR.z95,
    confidencePct: setup.confidencePct,
    horizon: setup.horizon,
    varUsdM,
    horizonLabel:
      setup.horizon === '1w' ? '1 week' : setup.horizon === '3m' ? '3 months' : '1 month',
    confidenceLabel: `${setup.confidencePct}%`,
    z95: NORDTECH_VAR.z95,
  };
}
