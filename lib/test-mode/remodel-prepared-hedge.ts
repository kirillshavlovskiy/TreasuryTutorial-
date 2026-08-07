/**
 * Instant remodel of a prepared hedge package (bullet ↔ strip, leg count,
 * settle tenure / skew) — same instruments as FX Risk path-chart controls.
 */

import {
  assignImpliedCarryFromSwapPoints,
  hedgeSettleWamMonths,
} from '@/lib/test-mode/cash-carry-analytics';
import type { PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';
import {
  buildRollingHedgeEdges,
  endMonthsFromScheduleWeights,
  rampStripScheduleWeights,
  shapedStripScheduleWeights,
  sizingForHedgePathBasis,
  type ForecastHedgeStructure,
} from '@/lib/test-mode/rolling-hedge';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import {
  horizonMonths,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

/** Strip settle-window skew (equal / front-loaded / back-loaded). */
export type SettleSkewId = 'neutral' | 'front' | 'back';

export function defaultStripLegCount(setup: VarSetup): number {
  const Tf = setup.forecastMonths;
  const Th = horizonMonths(setup.horizon);
  if (!(Tf > 0) || !(Th > 0)) return 2;
  return Math.max(2, Math.ceil(Tf / Th - 1e-12));
}

function skewToRampMode(
  skew: SettleSkewId,
): 'equal' | 'front' | 'back' {
  if (skew === 'front') return 'front';
  if (skew === 'back') return 'back';
  return 'equal';
}

/** Map continuous CoM → discrete settle-skew chip. */
export function settleSkewFromCenterOfMass(centerOfMass: number): SettleSkewId {
  const com = Math.min(1, Math.max(0, centerOfMass));
  if (com <= 0.38) return 'front';
  if (com >= 0.62) return 'back';
  return 'neutral';
}

/**
 * Rebuild prepared package for Cash Carry / Liquidity instrument knobs.
 * Keeps regime (basis) and ticket basis; restages legs / settle from controls.
 */
export function remodelPreparedHedgeInstruments(input: {
  ccy: string;
  current: PreparedHedgeProfile | undefined;
  structure: ForecastHedgeStructure;
  /** Bullet settle months from M0 (clamped to Tf). */
  bulletSettleMonths?: number;
  /** Strip equal-window leg count (min 2). */
  stripLegCount?: number;
  /** Strip settle skew — neutral / front-loaded / back-loaded. */
  settleSkew?: SettleSkewId;
  /**
   * Continuous shape (overrides discrete settleSkew ramp when provided).
   * CoM ∈ [0,1], kurtosis ∈ [−1,1] — same as `shapedStripScheduleWeights`.
   */
  centerOfMass?: number;
  kurtosis?: number;
  setup: VarSetup;
  stockNetM: number;
  monthlyFlows: readonly number[];
  marketRates: FxMarketRatesBundle;
}): PreparedHedgeProfile | null {
  const Tf =
    typeof input.setup.forecastMonths === 'number' &&
    input.setup.forecastMonths > 0
      ? Math.floor(input.setup.forecastMonths + 1e-12)
      : 0;
  if (!(Tf > 0)) return null;

  const basis = input.current?.basis ?? 'totalExpected';
  const ticketBasis =
    input.current?.ticketBasis ??
    (basis === 'cash'
      ? 'stock'
      : basis === 'totalExpected'
        ? 'totalBuildup'
        : 'simpleAvg');
  const hedgeRatio = input.current?.hedgeRatio ?? 0;
  const startM = input.stockNetM;
  const flows =
    input.monthlyFlows.length > 0
      ? input.monthlyFlows
      : Array.from({ length: Tf }, () => 0);

  if (input.structure === 'strip') {
    // Cash Carry / Liquidity: allow strip whenever Tf ≥ 2.
    if (Tf < 2) return null;
    const legCount = Math.max(
      2,
      Math.min(
        Math.max(2, Tf),
        Math.round(input.stripLegCount ?? defaultStripLegCount(input.setup)),
      ),
    );
    const useShaped =
      typeof input.centerOfMass === 'number' &&
      Number.isFinite(input.centerOfMass);
    const centerOfMass = useShaped
      ? Math.min(1, Math.max(0, input.centerOfMass!))
      : 0.5;
    const kurtosis =
      typeof input.kurtosis === 'number' && Number.isFinite(input.kurtosis)
        ? Math.min(1, Math.max(-1, input.kurtosis))
        : 0;
    const settleSkew: SettleSkewId = useShaped
      ? settleSkewFromCenterOfMass(centerOfMass)
      : (input.settleSkew ?? input.current?.settleSkew ?? 'neutral');
    const weights = useShaped
      ? shapedStripScheduleWeights(legCount, centerOfMass, kurtosis)
      : rampStripScheduleWeights(legCount, skewToRampMode(settleSkew));
    const endMonths = endMonthsFromScheduleWeights(weights, Tf);
    const edges = buildRollingHedgeEdges(
      startM,
      flows,
      input.setup,
      sizingForHedgePathBasis(basis),
      {
        legCount,
        endMonths: endMonths.length >= 2 ? endMonths : undefined,
        ccy: input.ccy,
        varSetup: input.setup,
      },
    );
    if (edges.length < 2) return null;
    const pathCover = edges[edges.length - 1]?.hedgeLocalM ?? 0;
    // Keep prior cover when only changing leg count / structure / skew.
    const prevCover = input.current?.coverLocalM ?? 0;
    const scale =
      Math.abs(pathCover) > 1e-12 && Math.abs(prevCover) > 1e-12
        ? prevCover / pathCover
        : 1;
    const scaledLegs = edges.map(e => ({
      index: e.index,
      startMonth: e.startMonth,
      endMonth: e.endMonth,
      settleMonths: e.endMonth,
      hedgeLocalM: e.hedgeLocalM * scale,
      label: e.label,
      stockStartM: e.stockStartM,
      endExposureM: e.endExposureM,
    }));
    const scaledCover =
      scaledLegs[scaledLegs.length - 1]?.hedgeLocalM ?? pathCover * scale;
    return assignImpliedCarryFromSwapPoints(
      {
        structure: 'strip',
        basis,
        ticketBasis,
        legs: scaledLegs,
        coverLocalM: scaledCover,
        hedgeRatio: input.current?.hedgeRatio ?? 0,
        cashDeliveryAt: 'periodEnd',
        settleSkew,
      },
      {
        marketRates: input.marketRates,
        bulletSettleMonths: Tf,
      },
    );
  }

  // Bullet — keep cover when remodeling settle only; else size from path.
  let coverLocalM = input.current?.coverLocalM ?? 0;
  if (Math.abs(coverLocalM) < 1e-12) {
    const edges = buildRollingHedgeEdges(
      startM,
      flows,
      input.setup,
      sizingForHedgePathBasis(basis),
      { legCount: 1, ccy: input.ccy, varSetup: input.setup },
    );
    coverLocalM =
      edges[edges.length - 1]?.hedgeLocalM ??
      startM + flows.reduce((a, b) => a + b, 0);
  }

  const settle = Math.max(
    0.25,
    Math.min(
      Tf,
      input.bulletSettleMonths ??
        input.current?.settleMonths ??
        Tf,
    ),
  );

  return assignImpliedCarryFromSwapPoints(
    {
      structure: 'bullet',
      basis,
      ticketBasis,
      legs: [],
      coverLocalM,
      hedgeRatio,
      cashDeliveryAt: 'periodEnd',
      settleMonths: settle,
    },
    {
      marketRates: input.marketRates,
      bulletSettleMonths: settle,
    },
  );
}

/**
 * Shift a prepared package's settle schedule to a settle-WAM chart target.
 * Same shape / Δ as today; scales (or collapses) leg settles to the chosen Mm.
 */
export function applySettleWamToPrepared(input: {
  current: PreparedHedgeProfile;
  /** Target WAM month index from the settle-WAM chart (M0…M12). */
  targetWamMonths: number;
  /** M0 strip / M1·start bullet — all spot, 0 FWD pts. */
  startConversion?: boolean;
  forecastMonths: number;
  marketRates: FxMarketRatesBundle;
}): PreparedHedgeProfile {
  const Tf =
    typeof input.forecastMonths === 'number' && input.forecastMonths > 0
      ? Math.floor(input.forecastMonths + 1e-12)
      : 0;
  const clamp = (m: number) =>
    Tf > 0 ? Math.min(Tf, Math.max(0, m)) : Math.max(0, m);
  const start = Boolean(input.startConversion);
  const target = start ? 0 : Math.max(0, input.targetWamMonths);

  if (input.current.structure === 'strip' && input.current.legs.length > 0) {
    let prev = 0;
    const samples = input.current.legs.map(leg => {
      const delta =
        typeof leg.tradeNotionalLocalM === 'number'
          ? leg.tradeNotionalLocalM
          : leg.hedgeLocalM - prev;
      prev = leg.hedgeLocalM;
      return {
        ccy: '',
        amountLocalM: delta,
        settleMonths: leg.settleMonths ?? leg.endMonth,
        recognizeMonths: 0,
        structure: 'strip' as const,
      };
    });
    const naturalWam = hedgeSettleWamMonths(samples);
    const legs =
      start || target <= 1e-12
        ? input.current.legs.map(leg => ({
            ...leg,
            settleMonths: 0,
          }))
        : naturalWam < 1e-12 || samples.length <= 1
          ? input.current.legs.map(leg => ({
              ...leg,
              settleMonths: clamp(target),
            }))
          : input.current.legs.map(leg => {
              const natural = leg.settleMonths ?? leg.endMonth;
              return {
                ...leg,
                settleMonths: clamp(natural * (target / naturalWam)),
              };
            });
    return assignImpliedCarryFromSwapPoints(
      { ...input.current, legs },
      {
        marketRates: input.marketRates,
        bulletSettleMonths: Tf > 0 ? Tf : target,
      },
    );
  }

  const settle = start ? 0 : clamp(target > 0 ? target : Tf);
  return assignImpliedCarryFromSwapPoints(
    {
      ...input.current,
      structure: 'bullet',
      legs: [],
      settleMonths: settle,
      cashDeliveryAt: start ? 'periodStart' : input.current.cashDeliveryAt,
    },
    {
      marketRates: input.marketRates,
      bulletSettleMonths: settle,
    },
  );
}
