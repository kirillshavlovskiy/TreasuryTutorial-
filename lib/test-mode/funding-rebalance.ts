/**
 * Portfolio rebalance — reallocate funding cover across names at constant risk.
 *
 * The per-name frontiers answer "what does cover cost this name". They cannot
 * answer "is the book allocated correctly", because they measure risk as each
 * name's own H* shortfall and shortfalls are not additive across a book. The
 * European names move together (EUR/PLN ρ ≈ 0.70–0.83) so hedging both buys
 * less than the sum of the parts; JPY against EM is the opposite. The measure
 * that is additive — and the one the desk is actually constrained by — is
 * component VAR, ∂(portfolio VAR)/∂(position), which `computePortfolioVAR`
 * already returns per name.
 *
 * So the question this answers is narrow and cheap:
 *
 *   holding total funding cover fixed, does moving cover between names buy
 *   more carry for the same diversified portfolio VAR?
 *
 * If yes, the current allocation is leaving carry on the table for free and the
 * gain is bankable without a new limit or an approval. If no, the book is
 * already at the constrained optimum and a bigger optimiser is not worth
 * building.
 *
 * At the optimum every funded name has the same marginal carry per unit of
 * component VAR. Where they differ, cover should move from the low-ratio name
 * to the high-ratio name. This walks that reallocation in small steps and stops
 * when the ratios meet or the risk budget would move.
 */

import {
  computePortfolioVAR,
  roundMoney,
  type PortfolioVARInput,
} from '@/lib/fx-buffer';
import {
  CCY_COVER_RATIOS,
  ccyFundingFrontier,
  type CcyFrontier,
  type CcyFrontierPoint,
} from '@/lib/test-mode/ccy-funding-frontier';
import type { LiquidityStrategyInput } from '@/lib/test-mode/liquidity-strategies';

export interface RebalanceName {
  ccy: string;
  /** Cover the live book runs on this name (1 = the regime's full strip). */
  coverNow: number;
  /** Cover the rebalance proposes. */
  coverProposed: number;
  /** Carry at each cover, $M/yr. */
  carryNowUsdYrM: number;
  carryProposedUsdYrM: number;
  /** Peak funding book at each cover, M FCY — what carries the VAR. */
  bookNowM: number;
  bookProposedM: number;
  /** Component VAR of the funded position, $M. Additive across the book. */
  componentVarNowUsdM: number;
  componentVarProposedUsdM: number;
  /** beta = component / standalone. Below 1 means the name diversifies. */
  betaNow: number;
  /**
   * Marginal carry per unit of component VAR at the current cover. The
   * equalisation target — names with a high ratio should be funded more.
   */
  marginalRatioNow: number;
  marginalRatioProposed: number;
}

export interface RebalanceResult {
  names: RebalanceName[];
  /** Carry on the live allocation, $M/yr. */
  carryNowUsdYrM: number;
  /** Carry after reallocation, $M/yr. */
  carryProposedUsdYrM: number;
  /** Free carry: proposed − now, at no extra portfolio VAR. */
  carryGainUsdYrM: number;
  /** Diversified portfolio VAR before and after — held ~constant by design. */
  portfolioVarNowUsdM: number;
  portfolioVarProposedUsdM: number;
  /** Sum of standalone VARs, for the diversification comparison. */
  standaloneSumNowUsdM: number;
  /** portfolio / standalone. Below 1 is the diversification benefit. */
  divFactorNow: number;
  /**
   * True when no reallocation helps — every funded name already prices the
   * same marginal carry per unit of component VAR.
   */
  alreadyOptimal: boolean;
  /** H* breaches on the live book and on the proposal — never made worse. */
  floorBreachesNow: number;
  floorBreachesProposed: number;
  /** Names excluded because they sit outside CORR_CURRENCIES. */
  excluded: string[];
  /**
   * Names whose cover was cut because its last unit destroyed carry *and*
   * carried portfolio VAR. These are over-hedged: the cut improves both legs,
   * so it is not a trade-off but a strictly better book.
   */
  dominated: string[];
}

/** Cover step used when walking the reallocation. */
const STEP = 0.1;
/** Portfolio VAR is held to this tolerance, $M. */
const VAR_TOL = 0.01;

function pointAt(f: CcyFrontier, cover: number): CcyFrontierPoint {
  let best = f.points[0]!;
  for (const p of f.points) {
    if (Math.abs(p.coverRatio - cover) < Math.abs(best.coverRatio - cover)) best = p;
  }
  return best;
}

/** Portfolio VAR of a set of funded books, using the shared correlation matrix. */
function varOf(books: { ccy: string; bookM: number }[]) {
  const inputs: PortfolioVARInput[] = books.map(b => ({
    ccy: b.ccy,
    cashFCY: Math.abs(b.bookM),
  }));
  return computePortfolioVAR(inputs);
}

/**
 * Marginal carry per unit of component VAR for the last unit of cover.
 *
 * Uses a backward difference wherever there is room below, and only falls
 * forward at cover = 0. A forward difference is undefined at cover = 1 — which
 * is where the live book starts on every name — so a forward-only measure
 * silently returns zero for the whole book and no reallocation is ever
 * proposed. The units are $/yr of carry per $ of portfolio VAR, comparable
 * across names of very different size.
 */
function marginalRatio(
  f: CcyFrontier,
  cover: number,
  componentVarUsdM: number,
  bookM: number,
): number {
  const here = pointAt(f, cover);
  const useBackward = cover > 1e-9;
  const other = pointAt(f, useBackward ? Math.max(0, cover - STEP) : Math.min(1, cover + STEP));
  // Signed so a positive ratio always means "more cover buys more carry".
  const dCarry = useBackward
    ? here.carryUsdYrM - other.carryUsdYrM
    : other.carryUsdYrM - here.carryUsdYrM;
  const dBook = useBackward
    ? Math.abs(here.peakBookM) - Math.abs(other.peakBookM)
    : Math.abs(other.peakBookM) - Math.abs(here.peakBookM);
  if (Math.abs(dBook) < 1e-9) return 0;
  // Component VAR scales ~linearly in position, so VAR per unit of book is a
  // good local proxy for the marginal risk of one cover step.
  const varPerBook = Math.abs(bookM) > 1e-9 ? componentVarUsdM / Math.abs(bookM) : 0;
  const dVar = dBook * varPerBook;
  if (Math.abs(dVar) < 1e-12) return 0;
  return dCarry / dVar;
}

/**
 * Reallocate cover at constant portfolio VAR and report the free carry.
 *
 * Returns null when fewer than two names are fundable — with one name there is
 * nothing to reallocate between.
 */
export function rebalanceFundingBook(
  input: LiquidityStrategyInput,
  strategyId?: string,
): RebalanceResult | null {
  const frontiers = new Map<string, CcyFrontier>();
  const excluded: string[] = [];

  // Which names have a dial at all, and which the corr matrix can price.
  for (const row of input.rows) {
    const f = ccyFundingFrontier(input, row.ccy, CCY_COVER_RATIOS, strategyId);
    if (!f || f.degenerate) continue;
    // computePortfolioVAR silently drops names outside CORR_CURRENCIES, which
    // would make the risk budget wrong rather than merely incomplete.
    const probeVar = varOf([{ ccy: row.ccy, bookM: 1 }]);
    if (probeVar.currencies.length === 0) {
      excluded.push(row.ccy);
      continue;
    }
    frontiers.set(row.ccy, f);
  }
  if (frontiers.size < 2) return null;

  const ccys = [...frontiers.keys()];
  const cover = new Map<string, number>(ccys.map(c => [c, 1]));

  const booksAt = (cv: Map<string, number>) =>
    ccys.map(c => ({
      ccy: c,
      bookM: pointAt(frontiers.get(c)!, cv.get(c)!).peakBookM,
    }));
  const carryAt = (cv: Map<string, number>) =>
    ccys.reduce(
      (s, c) => s + pointAt(frontiers.get(c)!, cv.get(c)!).carryUsdYrM,
      0,
    );

  /* H* is a policy floor, not a price. Portfolio VAR of the funded book falls
   * to zero when you fund nothing, so an objective that only counts held-FCY
   * risk always proposes zero cover. Compliance has to be a hard constraint:
   * never propose an allocation that breaches a cycle the live book clears. */
  const breachesAt = (cv: Map<string, number>) =>
    ccys.reduce(
      (n, c) => n + pointAt(frontiers.get(c)!, cv.get(c)!).floorBreaches,
      0,
    );
  const breachesNow = breachesAt(cover);
  const admissible = (cv: Map<string, number>) => breachesAt(cv) <= breachesNow;

  const varNow = varOf(booksAt(cover));
  const carryNow = carryAt(cover);
  const compNow = new Map(
    varNow.currencies.map(c => [c.ccy, c.component_VAR_USD]),
  );
  const betaNow = new Map(varNow.currencies.map(c => [c.ccy, c.beta]));

  const ratioNow = new Map(
    ccys.map(c => [
      c,
      marginalRatio(
        frontiers.get(c)!,
        cover.get(c)!,
        compNow.get(c) ?? 0,
        pointAt(frontiers.get(c)!, cover.get(c)!).peakBookM,
      ),
    ]),
  );

  const proposed = new Map(cover);
  const dominated: string[] = [];

  /* Phase 1 — domination. A negative marginal ratio means the last unit of
   * cover destroys carry AND carries portfolio VAR: cutting it improves both
   * legs at once, so there is no trade to balance. This must run before any
   * constant-risk reallocation, because a book sitting at full cover on every
   * name has nowhere to move cover *to* and the reallocation loop would report
   * "already optimal" on a book that is simply over-hedged. */
  {
    let guard = 0;
    for (;;) {
      if (++guard > 200) break;
      const v = varOf(booksAt(proposed));
      const comp = new Map(v.currencies.map(c => [c.ccy, c.component_VAR_USD]));
      const cuttable = ccys
        .filter(c => proposed.get(c)! > 1e-9)
        .map(c => ({
          ccy: c,
          r: marginalRatio(
            frontiers.get(c)!,
            proposed.get(c)!,
            comp.get(c) ?? 0,
            pointAt(frontiers.get(c)!, proposed.get(c)!).peakBookM,
          ),
        }))
        .filter(x => x.r < -1e-9);
      if (cuttable.length === 0) break;

      // Cut the most negative first — the unit of cover doing the most damage.
      const worst = cuttable.reduce((a, b) => (b.r < a.r ? b : a));
      const trial = new Map(proposed);
      trial.set(worst.ccy, Math.max(0, proposed.get(worst.ccy)! - STEP));
      if (carryAt(trial) <= carryAt(proposed) + 1e-12) break;
      if (varOf(booksAt(trial)).portfolio_VAR_USD > varNow.portfolio_VAR_USD + VAR_TOL) break;
      if (!admissible(trial)) break;

      proposed.set(worst.ccy, trial.get(worst.ccy)!);
      if (!dominated.includes(worst.ccy)) dominated.push(worst.ccy);
    }
  }

  /* Phase 2 — reallocation. Among what is left, move cover from the lowest
   * marginal ratio to the highest while portfolio VAR stays inside tolerance.
   * Each accepted swap is carry gained at no extra risk. */
  let guard = 0;
  for (;;) {
    if (++guard > 200) break;
    const v = varOf(booksAt(proposed));
    const comp = new Map(v.currencies.map(c => [c.ccy, c.component_VAR_USD]));
    const ratios = ccys.map(c => ({
      ccy: c,
      r: marginalRatio(
        frontiers.get(c)!,
        proposed.get(c)!,
        comp.get(c) ?? 0,
        pointAt(frontiers.get(c)!, proposed.get(c)!).peakBookM,
      ),
    }));

    const canUp = ratios.filter(x => proposed.get(x.ccy)! < 1 - 1e-9);
    const canDown = ratios.filter(x => proposed.get(x.ccy)! > 1e-9);
    if (canUp.length === 0 || canDown.length === 0) break;

    const up = canUp.reduce((a, b) => (b.r > a.r ? b : a));
    const down = canDown.reduce((a, b) => (b.r < a.r ? b : a));
    if (up.ccy === down.ccy || up.r - down.r < 1e-9) break;

    const trial = new Map(proposed);
    trial.set(up.ccy, Math.min(1, proposed.get(up.ccy)! + STEP));
    trial.set(down.ccy, Math.max(0, proposed.get(down.ccy)! - STEP));

    const trialVar = varOf(booksAt(trial));
    if (trialVar.portfolio_VAR_USD > varNow.portfolio_VAR_USD + VAR_TOL) break;
    if (carryAt(trial) <= carryAt(proposed) + 1e-12) break;
    if (!admissible(trial)) break;

    proposed.set(up.ccy, trial.get(up.ccy)!);
    proposed.set(down.ccy, trial.get(down.ccy)!);
  }

  const varProposed = varOf(booksAt(proposed));
  const compProposed = new Map(
    varProposed.currencies.map(c => [c.ccy, c.component_VAR_USD]),
  );
  const carryProposed = carryAt(proposed);

  const names: RebalanceName[] = ccys.map(c => {
    const f = frontiers.get(c)!;
    const pNow = pointAt(f, cover.get(c)!);
    const pProp = pointAt(f, proposed.get(c)!);
    return {
      ccy: c,
      coverNow: cover.get(c)!,
      coverProposed: proposed.get(c)!,
      carryNowUsdYrM: pNow.carryUsdYrM,
      carryProposedUsdYrM: pProp.carryUsdYrM,
      bookNowM: pNow.peakBookM,
      bookProposedM: pProp.peakBookM,
      componentVarNowUsdM: compNow.get(c) ?? 0,
      componentVarProposedUsdM: compProposed.get(c) ?? 0,
      betaNow: betaNow.get(c) ?? 1,
      marginalRatioNow: ratioNow.get(c) ?? 0,
      marginalRatioProposed: marginalRatio(
        f,
        proposed.get(c)!,
        compProposed.get(c) ?? 0,
        pProp.peakBookM,
      ),
    };
  });

  const gain = roundMoney(carryProposed - carryNow);
  return {
    names,
    carryNowUsdYrM: roundMoney(carryNow),
    carryProposedUsdYrM: roundMoney(carryProposed),
    carryGainUsdYrM: gain,
    portfolioVarNowUsdM: varNow.portfolio_VAR_USD,
    portfolioVarProposedUsdM: varProposed.portfolio_VAR_USD,
    standaloneSumNowUsdM: varNow.standalone_sum_USD,
    divFactorNow: varNow.div_factor,
    alreadyOptimal: Math.abs(gain) < 1e-9,
    floorBreachesNow: breachesNow,
    floorBreachesProposed: breachesAt(proposed),
    excluded,
    dominated,
  };
}
