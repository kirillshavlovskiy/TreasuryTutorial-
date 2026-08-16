import { describe, it, expect } from 'vitest';
import {
  accrualFactor,
  carryBasis,
  canEarnPositiveCarry,
  carryBasisLabel,
  carryForTarget,
  monthAccrualDays,
  projectCarryLifecycle,
  targetForCarry,
  twaBalance,
  type CarrySolveInput,
} from './carry-accrual';
import {
  CURRENCY_PARAMS,
  INITIAL_ROWS,
  INITIAL_USD_PARAMS,
  fundingSwapOverlayUsdYr,
  fundingSwapCashDeltaUsdYr,
  fundingSwapPathCarryUsdM,
  fundingSwapCipPointsUsdYr,
  type LayerId,
  type RowState,
} from './fx-buffer';
import { computeDashboardModel } from './dashboard-model';
import { DEFAULT_FORECAST_PROFILE, type ForecastProfileState } from './forecast-profile';
import { DEFAULT_LIQUIDITY_TIMING, type LiquidityTiming } from './liquidity-ladder';

const SHARED = { r_USD: 3.50, σ_P: 0.10, days: 3 };
const CARRY_LAYERS = new Set<LayerId>(['sigmaP', 'carryOptim', 'floorH']);
/** Mid-January so month 1 is the short February — day counts must not be assumed 30. */
const FROM = new Date(Date.UTC(2026, 0, 15));

const rowFor = (ccy: string): RowState => {
  const r = INITIAL_ROWS.find(x => x.ccy === ccy);
  if (!r) throw new Error(`no seed row for ${ccy}`);
  return r;
};

describe('carry conventions', () => {
  it('accrues sterling-bloc currencies ACT/365 and the rest ACT/360', () => {
    expect(carryBasis('GBP')).toBe(365);
    expect(carryBasis('PLN')).toBe(365);
    expect(carryBasis('EUR')).toBe(360);
    expect(carryBasis('JPY')).toBe(360);
    expect(carryBasisLabel('GBP')).toBe('ACT/365');
    expect(carryBasisLabel('EUR')).toBe('ACT/360');
  });

  it('counts actual calendar days per period', () => {
    expect(monthAccrualDays(0, FROM)).toBe(31); // January
    expect(monthAccrualDays(1, FROM)).toBe(28); // February 2026
    expect(monthAccrualDays(3, FROM)).toBe(30); // April
  });

  it('prices the same month differently on each basis', () => {
    expect(accrualFactor('EUR', 0, FROM)).toBeCloseTo(31 / 360, 10);
    expect(accrualFactor('GBP', 0, FROM)).toBeCloseTo(31 / 365, 10);
  });
});

describe('carry P&L ↔ cash target inversion', () => {
  const solve: CarrySolveInput = {
    ccy: 'EUR',
    r_FCY: 1.78,
    r_OD: 2.21,
    r_USD: 3.50,
    payout: -40,
    collections: 25,
    from: FROM,
  };

  it('round-trips a cash target through its carry and back', () => {
    const target = 180;
    const carry = carryForTarget(target, solve);
    expect(targetForCarry(carry, solve)).toBeCloseTo(target, 6);
  });

  it('round-trips an overdrawn target on the debit rate', () => {
    const target = -60;
    const carry = carryForTarget(target, solve);
    const twa = twaBalance(target, solve.payout, solve.collections);
    expect(twa).toBeLessThan(0);
    expect(targetForCarry(carry, solve)).toBeCloseTo(target, 6);
  });

  it('reads a PAY currency as negative carry on a long target', () => {
    // EUR earns 1.78% against 3.50% USD — holding the cash costs money.
    expect(carryForTarget(180, solve)).toBeLessThan(0);
  });

  it('answers a positive carry request on a PAY currency with a short position', () => {
    // The only way EUR earns against USD is to borrow it and hold USD instead —
    // the desk needs to see that, not a silently clamped long target.
    const target = targetForCarry(0.1, solve);
    expect(target).not.toBeNull();
    expect(target!).toBeLessThan(0);
  });

  it('refuses to invert when the rate differential is flat', () => {
    expect(targetForCarry(0.5, { ...solve, r_FCY: 3.50, r_OD: 3.50 })).toBeNull();
  });

  describe('a bid/offer straddling USD, as PLN does', () => {
    // PLN pays 3.41 long and costs 4.41 short against USD at 3.50, so both sides
    // lose and no target earns. The desk has to be told, not left with a dead field.
    const pln: CarrySolveInput = {
      ccy: 'PLN', r_FCY: 3.41, r_OD: 4.41, r_USD: 3.50,
      payout: -2.6, collections: 0.3, from: FROM,
    };

    it('reports that no positive carry is reachable', () => {
      expect(canEarnPositiveCarry(pln)).toBe(false);
      expect(canEarnPositiveCarry(solve)).toBe(true); // EUR earns it short
    });

    it('loses carry both long and short', () => {
      expect(carryForTarget(40, pln)).toBeLessThan(0);
      expect(carryForTarget(-40, pln)).toBeLessThan(0);
    });

    it('returns no target for a positive ask, and a real one for a loss', () => {
      expect(targetForCarry(0.05, pln)).toBeNull();
      const target = targetForCarry(-0.05, pln);
      expect(target).not.toBeNull();
      expect(carryForTarget(target!, pln)).toBeCloseTo(-0.05, 9);
    });
  });
});

describe('lifecycle projection', () => {
  const periods = projectCarryLifecycle(
    rowFor('EUR'), SHARED, CARRY_LAYERS, 6, null, { from: FROM },
  );

  it('returns one period per forecast month, labelled M1…MT', () => {
    expect(periods).toHaveLength(6);
    expect(periods.map(p => p.label)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
  });

  it('keeps Target = opening + swap in every period', () => {
    for (const p of periods) {
      expect(p.targetCash).toBeCloseTo(p.openingCash + p.swap, 4);
    }
  });

  it('chains each period opening off the prior close', () => {
    for (let i = 1; i < periods.length; i++) {
      expect(periods[i].openingCash).toBeCloseTo(periods[i - 1].endCash, 4);
    }
  });

  it('accumulates carry as a running sum', () => {
    let running = 0;
    for (const p of periods) {
      running += p.carryVsUsd;
      expect(p.cumCarryVsUsd).toBeCloseTo(running, 10);
    }
  });

  it('separates gross accrual from carry vs USD by the USD opportunity cost', () => {
    for (const p of periods) {
      const spread = p.grossAccrualUsd - p.carryVsUsd;
      expect(spread).toBeCloseTo(p.twaCash * 1.17010000 * (SHARED.r_USD / 100) * p.dcf, 6);
    }
  });
});

describe('manual carry target drives the book', () => {
  const baseInput = (rows: RowState[]) => ({
    rows,
    usdCash: 303.9,
    usdNonLpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: SHARED,
    activeLayers: CARRY_LAYERS,
    policyVAR: 5.0,
  });

  it('lands Target LP Cash on the requested level', () => {
    const target = 150;
    const rows = INITIAL_ROWS.map(r => (r.ccy === 'EUR' ? { ...r, carry_target: target } : r));
    const eur = computeDashboardModel(baseInput(rows)).fcyComputed.find(r => r.ccy === 'EUR')!;
    expect(eur.cash_threshold).toBeCloseTo(target, 4);
    // …without breaking the swap bridge that funds it.
    expect(eur.cash_threshold).toBeCloseTo(eur.cash + eur.swapNear, 4);
  });

  it('selling EUR to a Carry target CIP-nets Swap Carry — USD O/N + far-leg points offset FCY', () => {
    const target = 150;
    const rows = INITIAL_ROWS.map(r => (r.ccy === 'EUR' ? { ...r, carry_target: target } : r));
    const eur = computeDashboardModel({
      ...baseInput(rows),
      forecastProfile: DEFAULT_FORECAST_PROFILE,
    }).fcyComputed.find(r => r.ccy === 'EUR')!;
    const spot = CURRENCY_PARAMS.EUR?.spot ?? 1.1701;
    const n = eur.liquidityPlan?.[0]?.swap_needed ?? eur.swapNear;
    expect(n).toBeCloseTo(eur.swapNear, 6);
    if ((eur.sizingCycleIndex ?? 0) > 0) {
      const hStar = eur.liquidityPlan![eur.sizingCycleIndex!]!.swap_needed;
      expect(Math.abs(hStar - n)).toBeGreaterThan(0.01);
    }
    if (n < 0) {
      const cip = fundingSwapOverlayUsdYr(n, spot, eur.r_FCY, SHARED.r_USD, eur.r_OD);
      expect(cip.netUsdYr).toBeCloseTo(0, 8);
      expect(cip.usdOnUsdYr).toBeGreaterThan(0);
      expect(cip.pointsUsdYr).not.toBeCloseTo(0, 8);
    }
  });

  it('keeps a small carry target on the collapsed row and books M1 near, not the H* increment', () => {
    const target = 0.462;
    const rows = INITIAL_ROWS.map(r => (
      r.ccy === 'EUR'
        ? { ...r, carry_target: target, payout: -40, collections: 10 }
        : r
    ));
    const eur = computeDashboardModel({
      ...baseInput(rows),
      forecastProfile: {
        ...DEFAULT_FORECAST_PROFILE,
        liquidity: { ...DEFAULT_LIQUIDITY_TIMING, sizingBasis: 'horizon', granularity: 'week' },
      },
      shared: { ...SHARED, forecastMonths: 12 },
    }).fcyComputed.find(r => r.ccy === 'EUR')!;
    const m1 = eur.liquidityPlan![0]!.swap_needed;
    const sized = eur.sizingCycleIndex ?? 0;
    expect(sized).toBeGreaterThan(0);
    const hStar = eur.liquidityPlan![sized]!.swap_needed;
    // Collapsed SWAP is today's M1 trade (the −24.48), never the H* increment (the 4.44).
    expect(eur.swapNear).toBeCloseTo(m1, 6);
    expect(Math.abs(hStar - m1)).toBeGreaterThan(0.01);
    // Collapsed CARRY is the 462k ask, not Opening + H* increment (which printed 0).
    expect(eur.cash_threshold).toBeCloseTo(target, 2);
    expect(eur.postSwapCash).toBeCloseTo(eur.cash + m1, 6);
  });

  it('prices Swap Carry as cash Δr when a carry target is on — CIP would print 0', () => {
    const target = 0.462;
    const rows = INITIAL_ROWS.map(r => (
      r.ccy === 'EUR' ? { ...r, carry_target: target } : r
    ));
    const eur = computeDashboardModel({
      ...baseInput(rows),
      forecastProfile: DEFAULT_FORECAST_PROFILE,
    }).fcyComputed.find(r => r.ccy === 'EUR')!;
    const spot = CURRENCY_PARAMS.EUR?.spot ?? 1.1701;
    expect(eur.swapNear).toBeLessThan(-1);
    const cip = fundingSwapOverlayUsdYr(eur.swapNear, spot, eur.r_FCY, SHARED.r_USD, eur.r_OD);
    expect(cip.netUsdYr).toBeCloseTo(0, 6);
    const cash = fundingSwapCashDeltaUsdYr(eur.swapNear, spot, eur.r_FCY, SHARED.r_USD, eur.r_OD);
    expect(Math.abs(cash)).toBeGreaterThan(0.01);
    expect(eur.swapCarryUsdYr).toBeCloseTo(cash, 6);
    const path = fundingSwapPathCarryUsdM(
      eur.liquidityPlan, spot, eur.r_FCY, SHARED.r_USD, eur.r_OD, 'cashDelta',
    );
    expect(path).not.toBeNull();
    expect(Math.abs(path!)).toBeGreaterThan(0.01);
  });

  it('leaves every other currency untouched', () => {
    const plain = computeDashboardModel(baseInput(INITIAL_ROWS)).fcyComputed;
    const rows = INITIAL_ROWS.map(r => (r.ccy === 'EUR' ? { ...r, carry_target: 150 } : r));
    const withTarget = computeDashboardModel(baseInput(rows)).fcyComputed;
    for (const r of withTarget) {
      if (r.ccy === 'EUR') continue;
      const before = plain.find(p => p.ccy === r.ccy)!;
      expect(r.cash_threshold).toBeCloseTo(before.cash_threshold, 4);
    }
  });

  it('projects the manual target through the whole lifecycle', () => {
    const row = { ...rowFor('EUR'), carry_target: 150 };
    const periods = projectCarryLifecycle(row, SHARED, CARRY_LAYERS, 3, null, { from: FROM });
    for (const p of periods) {
      expect(p.targetCash).toBeCloseTo(150, 4);
    }
  });

  const ALL_LAYERS = new Set<LayerId>(['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv']);

  it('is not rescaled by the portfolio VAR budget fill', () => {
    // The optimizer picks one scale `s` to fill the VAR budget with carry. A manual
    // target is the desk's decision, so `s` must leave it alone and squeeze the
    // discretionary legs instead — across every limit the desk can set.
    const rows = INITIAL_ROWS.map(r => (r.ccy === 'EUR' ? { ...r, carry_target: 150 } : r));
    for (const policyVAR of [5, 25]) {
      const eur = computeDashboardModel({
        ...baseInput(rows), activeLayers: ALL_LAYERS, policyVAR,
      }).fcyComputed.find(r => r.ccy === 'EUR')!;
      expect(eur.cash_threshold).toBeCloseTo(150, 2);
      expect(eur.var_trim).toBeFalsy();
    }
  });

  it('still yields when the manual legs alone breach the limit, and says so', () => {
    // Every currency swung hard against a token limit — nothing left to squeeze,
    // so the cap has to scale the manual legs themselves back toward the book.
    const rows = INITIAL_ROWS.map(r => (
      r.ccy === 'USD' ? r : { ...r, carry_target: r.cash * 0.2 }
    ));
    const model = computeDashboardModel({
      ...baseInput(rows), activeLayers: ALL_LAYERS, policyVAR: 0.5,
    });
    const eur = model.fcyComputed.find(r => r.ccy === 'EUR')!;
    expect(eur.var_trim).toBe(true);
    // Trimmed back toward hold-the-book, never past the level asked for.
    expect(eur.cash_threshold).toBeGreaterThan(eur.carry_target!);
    expect(eur.cash_threshold).toBeLessThanOrEqual(eur.cash);
  });

  it('holds a short target so a PAY currency can earn positive carry', () => {
    // Borrowing EUR and holding USD is the only way EUR earns against USD. The
    // overdraft is cheaper than USD credit here (r_OD 2.21 < r_USD 3.50), so the
    // book must run the balance negative rather than clamping it at zero.
    const short = -76.9;
    const rows = INITIAL_ROWS.map(r => (r.ccy === 'EUR' ? { ...r, carry_target: short } : r));
    // Selling 191.7 down to −76.9 is a −268M overlay — only the VAR limit should
    // ever stand in its way, never a hidden clamp at zero.
    for (const [layers, policyVAR] of [[CARRY_LAYERS, 5], [ALL_LAYERS, 60]] as const) {
      const eur = computeDashboardModel({ ...baseInput(rows), activeLayers: layers, policyVAR })
        .fcyComputed.find(r => r.ccy === 'EUR')!;
      expect(eur.cash_threshold).toBeCloseTo(short, 2);
      expect(eur.cash_threshold).toBeCloseTo(eur.cash + eur.swapNear, 4);
      // Positive carry demand shorts PAY FCY → negative near → negative CIP points.
      expect(eur.swapNear).toBeLessThan(0);
      expect(eur.swapPointsUsdYr).toBeLessThan(0);
      const farLeg = eur.liquidityPlan?.[0]?.standing_swap ?? eur.swapNear;
      expect(farLeg).toBeLessThan(0);
      const spot = CURRENCY_PARAMS.EUR?.spot ?? 1.1701;
      const cip = fundingSwapCipPointsUsdYr(farLeg, spot, eur.r_FCY, SHARED.r_USD);
      expect(cip).toBeLessThan(0);
      expect(cip).toBeCloseTo(eur.swapPointsUsdYr, 6);
    }
  });

  it('is setup only — the book takes the target when the carry layer is on', () => {
    const rows = INITIAL_ROWS.map(r => (r.ccy === 'EUR' ? { ...r, carry_target: -76.9 } : r));
    const eurWith = (layers: Set<LayerId>) => computeDashboardModel({
      ...baseInput(rows), activeLayers: layers, policyVAR: 60,
    }).fcyComputed.find(r => r.ccy === 'EUR')!;

    expect(eurWith(new Set<LayerId>(['sigmaP', 'floorH', 'carryOptim', 'portfolioDiv'])).cash_threshold)
      .toBeCloseTo(-76.9, 2);
    // Off, the row is untouched by the target — the panel previews it, the book does not.
    expect(eurWith(new Set<LayerId>(['sigmaP', 'floorH', 'portfolioDiv'])).cash_threshold)
      .toBeGreaterThan(0);
  });

  it('previews the target the panel shows by running the layer on its own', () => {
    // What the modal renders: the carry stack's own answer, layer chip aside.
    const row = INITIAL_ROWS.find(r => r.ccy === 'EUR')!;
    const periods = projectCarryLifecycle(
      { ...row, carry_target: -76.9 }, SHARED, new Set<LayerId>(['carryOptim']), 3,
    );
    expect(periods[0].targetCash).toBeCloseTo(-76.9, 2);
  });

  it('respects a floor that sits above the requested target', () => {
    const rows = INITIAL_ROWS.map(r => (
      r.ccy === 'EUR' ? { ...r, carry_target: 10, cash_floor: 90 } : r
    ));
    const eur = computeDashboardModel(baseInput(rows)).fcyComputed.find(r => r.ccy === 'EUR')!;
    expect(eur.cash_threshold).toBeGreaterThan(10);
  });
});

describe('dated accrual — a cycle that changes sign', () => {
  /** Everything out on D1, everything back on D21: 20 days overdrawn, 10 in credit. */
  const timing: LiquidityTiming = {
    ...DEFAULT_LIQUIDITY_TIMING,
    enabled: true,
    granularity: 'day',
    byField: {
      payout: { from: 0, to: 0, curve: 'lump' },
      collections: { from: 20 / 30, to: 20 / 30, curve: 'lump' },
    },
  };
  const dated: ForecastProfileState = { ...DEFAULT_FORECAST_PROFILE, liquidity: timing };
  const flat: ForecastProfileState = {
    ...DEFAULT_FORECAST_PROFILE,
    liquidity: { ...timing, enabled: false },
  };
  const row: RowState = {
    ...rowFor('EUR'),
    cash: 100,
    payout: -180,
    collections: 150,
    fcastFX: 0,
    nonLpCash: 0,
    cash_floor: 0,
  };
  const noLayers = new Set<LayerId>();
  const project = (profile: ForecastProfileState) =>
    projectCarryLifecycle(row, SHARED, noLayers, 3, profile, { from: FROM });

  it('splits the cycle into its overdrawn and credit days', () => {
    const p = project(dated)[0]!;
    expect(p.swap).toBe(0);
    expect(p.debitDays).toBe(20);
    expect(p.creditDays).toBe(10);
    expect((p.debitDays ?? 0) + (p.creditDays ?? 0)).toBe(30);
  });

  it('reports a rate that reconciles with the accrual beside it', () => {
    const p = project(dated)[0]!;
    const spot = CURRENCY_PARAMS.EUR!.spot;
    expect(p.grossAccrualUsd).toBeCloseTo(
      p.twaCash * spot * (p.rateApplied / 100) * p.dcf,
      9,
    );
    // Credit days on a net-negative cycle push the effective rate past the debit
    // rate — the two sides carry opposite signs, so it is not a weighted average
    // bounded by them. Reconciling with the accrual is what the column is for.
    expect(p.twaCash).toBeLessThan(0);
    expect(p.rateApplied).toBeGreaterThan(row.r_OD);
  });

  it('parts company with the single-average version, and not by a rounding', () => {
    const [datedM1] = project(dated);
    const [flatM1] = project(flat);
    expect(flatM1!.debitDays).toBeUndefined();
    expect(flatM1!.rateApplied).toBe(row.r_FCY);
    // Netted to one balance the cycle looks long and never sees the overdraft.
    expect(Math.abs(datedM1!.carryVsUsd - flatM1!.carryVsUsd))
      .toBeGreaterThan(Math.abs(datedM1!.carryVsUsd));
  });

  it('leaves the projection untouched when timing is off', () => {
    expect(project(flat).map(p => p.carryVsUsd))
      .toEqual(projectCarryLifecycle(row, SHARED, noLayers, 3, null, { from: FROM })
        .map(p => p.carryVsUsd));
  });
});

describe('dated carry ↔ target inversion', () => {
  const timing: LiquidityTiming = {
    ...DEFAULT_LIQUIDITY_TIMING,
    enabled: true,
    byField: {
      payout: { from: 0, to: 0, curve: 'lump' },
      collections: { from: 20 / 30, to: 20 / 30, curve: 'lump' },
    },
  };
  const eur: CarrySolveInput = {
    ccy: 'EUR', r_FCY: 1.78, r_OD: 2.21, r_USD: 3.50,
    payout: -180, collections: 150, from: FROM, liquidity: timing,
  };
  /** PLN straddles USD: 3.41 long, 4.41 short — both sides lose, so carry peaks. */
  const pln: CarrySolveInput = {
    ccy: 'PLN', r_FCY: 3.41, r_OD: 4.41, r_USD: 3.50,
    payout: -40, collections: 30, from: FROM, liquidity: timing,
  };

  /**
   * Every target on a grid whose carry lands on `ask`, found without the solver.
   * The range has to be wide: the far branch of a concave curve can sit an order
   * of magnitude out from the near one.
   */
  function scanRoots(ask: number, input: CarrySolveInput): number[] {
    const roots: number[] = [];
    const step = 0.05;
    let prev = carryForTarget(-2000, input);
    for (let t = -2000 + step; t <= 2000; t += step) {
      const cur = carryForTarget(t, input);
      if ((prev - ask) * (cur - ask) <= 0 && Math.abs(cur - prev) > 1e-15) {
        roots.push(t - step + (step * (ask - prev)) / (cur - prev));
      }
      prev = cur;
    }
    return roots;
  }

  it('round-trips a target through its dated carry', () => {
    for (const target of [220, 40, -60]) {
      const carry = carryForTarget(target, eur);
      expect(targetForCarry(carry, eur)).toBeCloseTo(target, 5);
    }
  });

  it('prices a target on the days it is actually overdrawn', () => {
    // Target 40 leaves the cycle short for its first 20 days; a single-average
    // solve would read the same target as long throughout.
    const dated = carryForTarget(40, eur);
    const averaged = carryForTarget(40, { ...eur, liquidity: null });
    expect(dated).not.toBeCloseTo(averaged, 4);
  });

  it('takes the smaller position when two targets earn the same carry', () => {
    const ask = -0.02;
    const roots = scanRoots(ask, pln);
    expect(roots.length).toBe(2);
    const solved = targetForCarry(ask, pln);
    expect(solved).not.toBeNull();
    expect(carryForTarget(solved!, pln)).toBeCloseTo(ask, 9);
    const nearest = roots.reduce((a, b) => (Math.abs(a) < Math.abs(b) ? a : b));
    const far = roots.find(r => r !== nearest)!;
    expect(solved!).toBeCloseTo(nearest, 1);
    expect(Math.abs(solved!)).toBeLessThan(Math.abs(far));
    // The rejected answer is a real one — it earns the same carry on a position
    // several times the size, which is why the tie-break exists.
    expect(carryForTarget(far, pln)).toBeCloseTo(ask, 4);
  });

  it('refuses an ask above the reachable peak', () => {
    expect(scanRoots(0.05, pln)).toHaveLength(0);
    expect(targetForCarry(0.05, pln)).toBeNull();
  });

  it('prices the hedge leg settling in the cycle', () => {
    const delivering: CarrySolveInput = { ...eur, hedgeSettle: -60 };
    expect(carryForTarget(120, delivering)).not.toBeCloseTo(
      carryForTarget(120, eur), 6,
    );
    // And the inversion still returns the target that earns the ask.
    const carry = carryForTarget(120, delivering);
    expect(targetForCarry(carry, delivering)).toBeCloseTo(120, 5);
  });
});

describe('hedge settlement in the carry lifecycle', () => {
  const timing: LiquidityTiming = {
    ...DEFAULT_LIQUIDITY_TIMING,
    enabled: true,
    granularity: 'day',
    byField: {
      payout: { from: 0, to: 0, curve: 'lump' },
      collections: { from: 20 / 30, to: 20 / 30, curve: 'lump' },
      hedgeSettle: { from: 0, to: 0, curve: 'lump' },
    },
  };
  const dated: ForecastProfileState = { ...DEFAULT_FORECAST_PROFILE, liquidity: timing };
  const row: RowState = {
    ...rowFor('EUR'),
    cash: 200,
    payout: -60,
    collections: 50,
    fcastFX: 0,
    nonLpCash: 0,
    cash_floor: 0,
  };
  const noLayers = new Set<LayerId>();
  const project = (hedgeSettle?: number[]) =>
    projectCarryLifecycle(row, SHARED, noLayers, 3, dated, { from: FROM, hedgeSettle });

  it('settles in the cycle it belongs to and carries forward from there', () => {
    const bare = project();
    const hedged = project([0, -120, 0]);
    expect(hedged[0]!.carryVsUsd).toBeCloseTo(bare[0]!.carryVsUsd, 9);
    expect(hedged[1]!.twaCash).toBeCloseTo(bare[1]!.twaCash - 120, 6);
    // The delivery is gone from the account for good, so cycle 3 opens lower too.
    expect(hedged[2]!.openingCash).toBeCloseTo(bare[2]!.openingCash - 120, 6);
  });

  it('prices the days the delivery overdraws the account on the debit rate', () => {
    // Settling on D10 leaves the cycle long for its first nine days and short
    // after — one cycle, two sides of zero.
    const midMonth: ForecastProfileState = {
      ...dated,
      liquidity: {
        ...timing,
        byField: { ...timing.byField, hedgeSettle: { from: 9 / 30, to: 9 / 30, curve: 'lump' } },
      },
    };
    const cycle = projectCarryLifecycle(
      row, SHARED, noLayers, 3, midMonth, { from: FROM, hedgeSettle: [0, -200, 0] },
    )[1]!;
    const spot = CURRENCY_PARAMS.EUR!.spot;
    expect(cycle.debitDays).toBeGreaterThan(0);
    expect(cycle.creditDays).toBeGreaterThan(0);
    // Read on the credit rate alone the same average balance gives a different
    // answer: EUR at 2.21 short against USD 3.50 is not EUR at 1.78 long.
    const asCredit = cycle.twaCash * spot * ((row.r_FCY - SHARED.r_USD) / 100) * cycle.dcf;
    expect(cycle.carryVsUsd).not.toBeCloseTo(asCredit, 4);
  });

  it('is invisible without a hedge book', () => {
    expect(project([0, 0, 0]).map(p => p.carryVsUsd))
      .toEqual(project().map(p => p.carryVsUsd));
  });
});
