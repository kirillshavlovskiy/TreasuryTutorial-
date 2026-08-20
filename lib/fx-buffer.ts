// FX Buffer Simulator — business logic
// All formulas sourced from .claude/rules/project/decisions.md

import { allocateCarryVarUsd } from '@/lib/portfolio-alloc';

export interface SharedGlobals {
  r_USD: number;   // JPM NP USD credit rate % p.a.
  σ_P: number;     // payout forecast uncertainty fraction (0.10 = 10%)
  days: number;    // settlement gap days
  /**
   * FX Risk forecast period in months. Scales monthly Revenue (collections) /
   * Expenses (payout) / fcastFX into Net FX Forecast. Default 1 when omitted.
   */
  forecastMonths?: number;
}

export interface CurrencyParam {
  σ_daily: number;   // daily log-return std dev
  carry: number;     // % p.a. — JPM NP credit rate (Jan 2026)
  β_IR: number;      // IR sensitivity coefficient
  r_OD: number;      // % p.a. — JPM NP debit rate (Jan 2026)
  spot: number;      // USD per 1 FCY unit (Apr 2026, from JPM NP FX report)
}

// Rates source: JPM Notional Pool Base Rate Report LU_661 (30-Jan-2026), rounded to 2dp
// Spot source:  JPM NP FX Report On-Demand LU_661 (30-Apr-2026)
// carry = LP credit rate | r_OD = LP debit rate | spot = USD per 1 FCY
export const CURRENCY_PARAMS: Record<string, CurrencyParam> = {
  AED: { σ_daily: 0.000045, carry:  2.05, β_IR: 0.00, r_OD:  4.55, spot: 0.27225330 },
  AUD: { σ_daily: 0.008227, carry:  3.27, β_IR: 0.25, r_OD:  4.07, spot: 0.71415000 },
  CAD: { σ_daily: 0.004256, carry:  1.49, β_IR: 0.25, r_OD:  2.39, spot: 0.73112776 },
  CHF: { σ_daily: 0.004312, carry: -0.32, β_IR: 0.15, r_OD:  0.15, spot: 1.26630366 },
  CNY: { σ_daily: 0.002541, carry:  0.72, β_IR: 0.10, r_OD:  2.92, spot: 0.14567703 },
  CZK: { σ_daily: 0.005609, carry:  2.51, β_IR: 0.40, r_OD:  3.61, spot: 0.04796968 },
  DKK: { σ_daily: 0.004193, carry:  0.99, β_IR: 0.15, r_OD:  1.79, spot: 0.15658029 },
  EUR: { σ_daily: 0.004372, carry:  1.78, β_IR: 0.20, r_OD:  2.21, spot: 1.17010000 },
  GBP: { σ_daily: 0.004966, carry:  3.57, β_IR: 0.25, r_OD:  4.00, spot: 1.35015000 },
  HKD: { σ_daily: 0.000465, carry:  1.67, β_IR: 0.00, r_OD:  2.67, spot: 0.12759822 },
  HUF: { σ_daily: 0.007234, carry:  5.69, β_IR: 0.55, r_OD:  6.79, spot: 0.00320333 },
  ILS: { σ_daily: 0.005285, carry:  3.02, β_IR: 0.35, r_OD:  5.02, spot: 0.33639452 },
  JPY: { σ_daily: 0.005082, carry:  0.45, β_IR: 0.15, r_OD:  0.95, spot: 0.00624590 },
  MXN: { σ_daily: 0.007892, carry:  6.19, β_IR: 0.60, r_OD:  7.59, spot: 0.05724770 },
  NOK: { σ_daily: 0.007846, carry:  3.28, β_IR: 0.30, r_OD:  4.08, spot: 0.10766001 },
  NZD: { σ_daily: 0.006398, carry:  2.20, β_IR: 0.25, r_OD:  3.40, spot: 0.58465000 },
  PLN: { σ_daily: 0.006363, carry:  3.41, β_IR: 0.50, r_OD:  4.41, spot: 0.27486120 },
  RON: { σ_daily: 0.004522, carry:  0.00, β_IR: 0.45, r_OD:  6.05, spot: 0.22941568 },
  RSD: { σ_daily: 0.004171, carry:  0.00, β_IR: 0.45, r_OD: 20.00, spot: 0.00996512 },
  SEK: { σ_daily: 0.006511, carry:  1.66, β_IR: 0.25, r_OD:  2.46, spot: 0.10767972 },
  SGD: { σ_daily: 0.002694, carry:  0.94, β_IR: 0.15, r_OD:  1.84, spot: 0.78149422 },
  THB: { σ_daily: 0.004254, carry:  2.00, β_IR: 0.25, r_OD:  5.50, spot: 0.02890000 },
  TRY: { σ_daily: 0.009301, carry:  1.16, β_IR: 0.80, r_OD: 34.16, spot: 0.02218783 },
  USD: { σ_daily: 0.000000, carry:  3.50, β_IR: 0.00, r_OD:  3.89, spot: 1.00000000 },
  ZAR: { σ_daily: 0.008518, carry:  6.01, β_IR: 0.60, r_OD:  7.31, spot: 0.05981255 },
};

/** USD per 1 FCY unit for `ccy` (1.0 for USD). */
export function ccySpotRate(ccy: string): number {
  return CURRENCY_PARAMS[ccy]?.spot ?? 1;
}

/**
 * Round money / notional figures so IEEE-754 noise never lands in state or inputs
 * (e.g. 3.400000000000002 → 3.4). 8 dp is far below UI precision for M units.
 */
export function roundMoney(v: number, dp = 8): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Convert M FCY → M USD using TMS spot rate. */
export function fcyToUsdM(fcy: number, ccy: string): number {
  return roundMoney(fcy * ccySpotRate(ccy));
}

/** Convert M USD → M FCY using TMS spot rate. */
export function usdToFcyM(usd: number, ccy: string): number {
  const rate = ccySpotRate(ccy);
  return rate > 0 ? roundMoney(usd / rate) : 0;
}

/**
 * Net FX book (M FCY): long cash/fwd/assets minus FCY debt.
 * `ir_liab_notional` is entered as a positive liability notional → short FX → deducted.
 * `ir_invest_notional` is a long investment asset → added.
 */
export function fxBookNetLocalM(
  row: Pick<
    RowState,
    | 'ccy'
    | 'spot'
    | 'fwd'
    | 'nonCash'
    | 'nonCashAsset'
    | 'ir_liab_notional'
    | 'ir_invest_notional'
  >,
): number {
  const fwdFcy = usdToFcyM(row.fwd, row.ccy);
  const invest = row.ir_invest_notional ?? 0;
  const debt = row.ir_liab_notional; // +notional = liability short
  return roundMoney(
    row.spot + fwdFcy + row.nonCash + (row.nonCashAsset ?? 0) + invest - debt,
  );
}

// ── Swap overlay formulas ──────────────────────────────────────────────────

/** 1-month VAR factor at 95% confidence: σ_daily × √21 × 1.645 */
export function var95_1m_factor(σ_daily: number): number {
  return σ_daily * Math.sqrt(21) * 1.645;
}

/** combined_multiplier = 1 + (carry% / 100) × β_IR */
export function combinedMultiplier(carry_pct: number, β_IR: number): number {
  return 1 + (carry_pct / 100) * β_IR;
}

/**
 * Dynamic minimum cash threshold (H).
 * H = MAX(cash_floor, |C+D| × VAR95_1M_factor × combined_multiplier)
 *
 * NOTE: H protects the NWC P&L buffer, not FCY payment capacity.
 * FCY liquidity is already guaranteed by the EOM forward structure.
 */
export function calcDynamicH(
  netPosition: number, // C + D
  ccy: string,
  cash_floor = 0.05   // M FCY floor (50K FCY default)
): number {
  const p = CURRENCY_PARAMS[ccy];
  if (!p) return cash_floor;
  const vf = var95_1m_factor(p.σ_daily);
  const mult = combinedMultiplier(p.carry, p.β_IR);
  return Math.max(cash_floor, Math.abs(netPosition) * vf * mult);
}

/**
 * Swap near leg: I = MAX(H − (F + G), −(C + D))
 * Satisfies both constraints simultaneously:
 *   1. Cash maintenance: bring cash to threshold H
 *   2. Position neutralization: cover net FCY position
 */
export function calcSwapNear(C: number, D: number, F: number, G: number, H: number): number {
  return Math.max(H - (F + G), -(C + D));
}

/**
 * Monthly carry income/cost on the net FCY position.
 * L = −(C + D) × carry_rate_pct/100
 * Sign: short position (C+D<0) → positive carry income
 */
export function calcCarry(C: number, D: number, carry_rate_pct: number): number {
  return -(C + D) * carry_rate_pct / 100;
}

/** Delta = C + D + L + E  (I + J cancel to zero) */
export function calcDelta(C: number, D: number, L: number, E: number): number {
  return C + D + L + E;
}

// ── Buffer optimizer — interest rate optimized threshold ──────────────────
//
// Key insight from model review (2026-04-29):
//   H is an interest rate optimization problem, not an FX risk problem.
//   The EOM forward already guarantees FCY delivery.
//   Optimal H minimizes: cost_of_holding + expected_cost_of_overdraft
//
//   H* = MAX(H_min, P × (1 + σ_P × Φ⁻¹(1 − Δr/r_OD)))
//   where Δr = r_USD − r_FCY

/** Inverse normal CDF — Peter Acklam algorithm (error < 1.15e-9) */
export function normInv(p: number): number {
  if (p <= 0.0001) return -3.72;
  if (p >= 0.9999) return  3.72;

  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
              1.383577518672690e+02, -3.066479806614716e+01,  2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
              6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00,  4.374664141464968e+00,  2.938163982698783e+00];
  const d = [ 7.784695709041462e-03,  3.224671290700398e-01,  2.445134137142996e+00,
              3.754408661907416e+00];

  const p_lo = 0.02425, p_hi = 1 - p_lo;

  if (p < p_lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= p_hi) {
    const q = p - 0.5, r = q*q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

export function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export interface BufferOptParams {
  P: number;         // Expected payouts (M FCY)
  σ_P: number;       // Forecast uncertainty fraction (0.10 = 10%)
  r_USD: number;     // USD deposit rate % p.a.
  r_FCY: number;     // FCY deposit rate % p.a.
  r_OD: number;      // Overdraft rate % p.a.
  days: number;      // Settlement gap (days)
  cash_floor?: number; // Floor (M FCY)
}

export interface BufferOptResult {
  H_optimal: number;
  H_pct_of_P: number;
  shortfall_prob_pct: number;
  delta_r: number;
  C_hold_daily: number;
  C_OD_daily: number;
  TC_daily: number;
  carry_direction: 'earn' | 'pay' | 'neutral';
  z_score: number;
}

export function calcOptimalBuffer(params: BufferOptParams): BufferOptResult {
  const { P, σ_P, r_USD, r_FCY, r_OD, days, cash_floor = 0 } = params;
  const delta_r_pct = r_USD - r_FCY;
  const delta_r_dec = delta_r_pct / 100;
  const r_OD_dec = (r_OD || 0.01) / 100;

  const raw_ratio = delta_r_dec / r_OD_dec;
  const shortfall_prob = Math.max(0.001, Math.min(0.999, raw_ratio));
  const z = normInv(1 - shortfall_prob);

  const H_raw = P * (1 + (σ_P > 0 ? σ_P * z : 0));
  const H_optimal = Math.max(cash_floor, H_raw);

  const z_H = σ_P > 0 ? (H_optimal - P) / (σ_P * P) : 0;
  const period = (days || 1) / 365;
  const C_hold = Math.max(0, delta_r_dec) * H_optimal * period;
  const C_OD = σ_P * P * normPDF(z_H) * r_OD_dec * period;

  return {
    H_optimal,
    H_pct_of_P: P > 0 ? (H_optimal / P) * 100 : 0,
    shortfall_prob_pct: shortfall_prob * 100,
    delta_r: delta_r_pct,
    C_hold_daily: C_hold / (days || 1),
    C_OD_daily: C_OD / (days || 1),
    TC_daily: (C_hold + C_OD) / (days || 1),
    carry_direction: delta_r_pct > 0.05 ? 'pay' : delta_r_pct < -0.05 ? 'earn' : 'neutral',
    z_score: z,
  };
}

// ── Sensitivity generators ────────────────────────────────────────────────

export type SensParam = 'deltaR' | 'sigmaP' | 'r_OD';
export interface SensPoint { x: number; y: number; }
export interface SensSeries { name: string; color: string; data: SensPoint[]; }

const SENS_RANGES: Record<SensParam, [number, number]> = {
  deltaR: [-6, 8],
  sigmaP: [0, 0.30],
  r_OD:   [2, 25],
};

export function genSensitivity(
  base: BufferOptParams,
  param: SensParam,
  steps = 60
): SensSeries[] {
  const [lo, hi] = SENS_RANGES[param];

  const series = (label: string, color: string, overrides: Partial<BufferOptParams>): SensSeries => ({
    name: label, color,
    data: Array.from({ length: steps + 1 }, (_, i) => {
      const x = lo + (hi - lo) * i / steps;
      let p: BufferOptParams;
      if (param === 'deltaR')      p = { ...base, ...overrides, r_FCY: base.r_USD - x };
      else if (param === 'sigmaP') p = { ...base, ...overrides, σ_P: x };
      else                         p = { ...base, ...overrides, r_OD: x };
      return { x, y: calcOptimalBuffer(p).H_pct_of_P };
    }),
  });

  if (param === 'deltaR') {
    return [
      series('σ_P = 5%',  '#2563eb', { σ_P: 0.05 }),
      series('σ_P = 10%', '#16a34a', { σ_P: 0.10 }),
      series('σ_P = 20%', '#dc2626', { σ_P: 0.20 }),
    ];
  } else if (param === 'sigmaP') {
    return [
      series('Δr = −2% (earn)', '#2563eb', { r_FCY: base.r_USD + 2 }),
      series('Δr = 0%',          '#16a34a', { r_FCY: base.r_USD }),
      series('Δr = +2% (pay)',   '#dc2626', { r_FCY: base.r_USD - 2 }),
      series('Δr = +4% (pay)',   '#d97706', { r_FCY: base.r_USD - 4 }),
    ];
  } else {
    return [
      series('Δr = −2%', '#2563eb', { r_FCY: base.r_USD + 2 }),
      series('Δr = +1%', '#16a34a', { r_FCY: base.r_USD - 1 }),
      series('Δr = +3%', '#dc2626', { r_FCY: base.r_USD - 3 }),
    ];
  }
}

// ── Multi-currency comparison table ──────────────────────────────────────

export interface MultiCcyRow {
  ccy: string;
  r_FCY: number;
  r_OD: number;
  delta_r: number;
  H_pct: number;
  shortfall_pct: number;
  carry_dir: 'earn' | 'pay' | 'neutral';
}

export function calcMultiCcyTable(
  P: number, σ_P: number, days: number, r_USD: number
): MultiCcyRow[] {
  const ccys = DISPLAY_CURRENCIES;
  return ccys
    .map(ccy => {
      const p = CURRENCY_PARAMS[ccy];
      if (!p) return null;
      const res = calcOptimalBuffer({ P, σ_P, r_USD, r_FCY: p.carry, r_OD: p.r_OD, days });
      return {
        ccy,
        r_FCY: p.carry,
        r_OD: p.r_OD,
        delta_r: res.delta_r,
        H_pct: res.H_pct_of_P,
        shortfall_pct: res.shortfall_prob_pct,
        carry_dir: res.carry_direction,
      } as MultiCcyRow;
    })
    .filter(Boolean)
    .sort((a, b) => b!.H_pct - a!.H_pct) as MultiCcyRow[];
}

// ── Layered buffer decomposition ──────────────────────────────────────────
//
// Decomposes H* into additive layers so each parameter's contribution is
// independently visible.  Layers are applied in order:
//   1. Floor    (floor_contrib = cash_floor if floorH on, else 0) — hard minimum
//   2. Safety   (+delta_sigma = P × σ_P × z_neutral)             — forecast uncertainty margin
//   3. Carry    (±delta_carry = P × σ_P × Δz)                    — rate-differential adjustment
//   4. CFaR     (delta_cfar = Net CFaR in FCY) — FX-hedge residual readout.
//                 Not FCY liquidity: a USD CFaR event does not change how much
//                 AUD you need to pay AUD invoices. Do not size Swap Near from it.
// P is the expected outflow volume scale — it sizes the safety and carry deltas only.

export const Z_NEUTRAL = 1.645; // 95% confidence neutral z-score

export type LayerId = 'sigmaP' | 'carryOptim' | 'floorH' | 'portfolioDiv' | 'cfarCover';

/** Chip groups on the buffer-layer rail — each gear opens that group's settings. */
export type BufferChipKey = 'floorH' | 'forecastAccuracy' | 'carryOptim' | 'portfolioDiv';

/** Payout-σ and Net CFaR cover — one forecast-accuracy buffer in the desk UI. */
export const FORECAST_ACCURACY_LAYERS: readonly LayerId[] = ['sigmaP', 'cfarCover'];

export function forecastAccuracyLayerOn(active: Set<LayerId> | undefined): boolean {
  return FORECAST_ACCURACY_LAYERS.some(id => active?.has(id) === true);
}

/** Flip a layer group to a single on/off so mixed leftover state collapses. */
export function toggleLayerGroup(
  layers: readonly LayerId[],
  active: Set<LayerId> | undefined,
  toggle: (id: LayerId) => void,
): void {
  const next = !layers.some(id => active?.has(id) === true);
  for (const id of layers) {
    if (Boolean(active?.has(id)) !== next) toggle(id);
  }
}

/**
 * Where buffer chips apply.
 *   currency  — each name’s own floor / σ / carry ask
 *   portfolio — same chips, joint mix: Σ⁻¹μ overlay, Policy VAR + USD budget
 */
export type BufferLevel = 'currency' | 'portfolio';

export function bufferLevelOf(active: Set<LayerId> | undefined): BufferLevel {
  return active?.has('portfolioDiv') ? 'portfolio' : 'currency';
}

/** Portfolio level is `portfolioDiv` — MV allocator + shared Policy VAR cap. */
export function setBufferLevel(
  active: Set<LayerId> | undefined,
  level: BufferLevel,
  toggle: (id: LayerId) => void,
): void {
  const on = active?.has('portfolioDiv') === true;
  if (level === 'portfolio' && !on) {
    toggle('portfolioDiv');
    // Bring every layer the portfolio frontier can bend on. This removes
    // the "forgot to flip a chip" failure mode entirely — it does NOT
    // fabricate floor values or CFaR exposure numbers, which are real desk
    // inputs. With every layer on and all of them still at 0, the frontier
    // is correctly a straight line: that means the book genuinely has no
    // floor set and no recorded exposure, not that a layer is missing.
    if (!active?.has('floorH')) toggle('floorH');
    if (!active?.has('carryOptim')) toggle('carryOptim');
    if (!active?.has('cfarCover')) toggle('cfarCover');
  }
  if (level === 'currency' && on) toggle('portfolioDiv');
}

/** Desk Policy VAR approval rungs — overlay sensitivity cap ($M). */
export const POLICY_VAR_LIMITS = [
  { usd: 5, label: '$5M', who: 'Treasury' },
  { usd: 10, label: '$10M', who: 'Director' },
  { usd: 20, label: '$20M', who: 'CFO' },
] as const;

/**
 * Bounded sweep cap ($M) for the named optimization presets.
 * Always covers the approval rungs ($5–$20); stretches a little past the
 * first floor-clamp so the knee is interior, but never traces an unbounded
 * EARN ray (hard ceiling = 1.5× the top rung).
 */
export function universePolicyVarCap(nearestClampVarUsd: number | null): number {
  const minTier = POLICY_VAR_LIMITS[0]!.usd;
  const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
  // Presets live on $5–$20. The sweep still has to reach the first PAY
  // floor-clamp or the ray never bends. 4× the top rung is a hard ceiling
  // so an EARN-only book cannot walk to infinity.
  const limit = maxTier * 4;
  const aroundClamp = nearestClampVarUsd != null
    && Number.isFinite(nearestClampVarUsd)
    && nearestClampVarUsd > 0
    ? nearestClampVarUsd * 1.6
    : 0;
  return Math.min(Math.max(maxTier, minTier * 3, aroundClamp), limit);
}

/** True when any liquidity-funding layer is on — no layer selected means no swap. */
export function liquidityFormulaLayersActive(active: Set<LayerId>): boolean {
  return active.has('floorH')
    || active.has('sigmaP')
    || active.has('carryOptim')
    || active.has('portfolioDiv');
}

export interface LayeredBufferResult {
  P_contrib: number;      // P when sigmaP layer is active, else 0 — the payout base included in H*
  floor_contrib: number;  // per-currency floor contribution (cash_floor if floorH on, else 0)
  delta_sigma: number;   // always ≥ 0 — safety margin for outflow forecast uncertainty
  delta_carry: number;   // can be negative (PAY carry) or positive (EARN carry)
  /** FX-hedge Net CFaR in FCY — 0 unless the CFaR cover layer is on. Not Swap Near. */
  delta_cfar: number;
  raw_sum: number;       // floor_contrib + delta_sigma + delta_carry (no CFaR)
  cash_threshold: number; // PRE-PAYOUT target (may be floored at 0 when r_OD > r_FCY)
  floor_binding: boolean; // display indicator: true when (delta_sigma + delta_carry) < 0
  z_opt: number;         // optimal z used (= Z_NEUTRAL when carryOptim is off)
  carry_dir: 'earn' | 'pay' | 'neutral';
  delta_r: number;       // r_USD − r_FCY
  debit_floor_binding?: boolean; // H* clamped to 0 — expensive overdraft (r_OD > r_FCY)
  /** A manual carry target was supplied and drove delta_carry instead of z_opt. */
  carry_target_applied?: boolean;
  /** The manual carry target could not be met — a floor or debit clamp bound first. */
  carry_target_binding?: boolean;
}

/**
 * Funding-swap overlay vs the unfunded cash path.
 *
 * Near buy FCY (swapNear > 0, covering a short / zero H*): FCY O/N is the
 * debit you extinguish (`r_OD`), USD O/N is the credit you miss on the USD
 * sold to buy FCY, points are CIP mid on the **credit** curve (the swap
 * market far leg). Net = (r_OD − r_FCY) × notional — OD vs market, not CIP-zero.
 *
 * Near sell FCY (swapNear < 0): you receive USD on the near (USD O/N credit).
 * FCY O/N is credit forgone (`r_FCY`); far-leg points offset FCY+USD so
 * `netUsdYr` is 0 at CIP mid. There is no leftover “carry vs USD” on the
 * FCY short — the matching USD long and the points reverse it.
 *
 * Additive to unfunded cash carry — does not reprice the cash path.
 */
export interface FundingSwapOverlay {
  fcyOnUsdYr: number;
  usdOnUsdYr: number;
  pointsUsdYr: number;
  netUsdYr: number;
}

export function fundingSwapOverlayUsdYr(
  swapNear: number,
  spot: number,
  r_FCY: number,
  r_USD: number,
  r_OD?: number,
): FundingSwapOverlay {
  const covering = swapNear > 0
    && typeof r_OD === 'number'
    && Number.isFinite(r_OD);
  const fcyRate = covering ? r_OD : r_FCY;
  const fcyOnUsdYr = swapNear * (fcyRate / 100) * spot;
  const usdOnUsdYr = -swapNear * (r_USD / 100) * spot;
  // Swap market points stay on the credit curve even when FCY O/N is OD.
  const pointsUsdYr = -swapNear * ((r_FCY - r_USD) / 100) * spot;
  return {
    fcyOnUsdYr,
    usdOnUsdYr,
    pointsUsdYr,
    netUsdYr: fcyOnUsdYr + usdOnUsdYr + pointsUsdYr,
  };
}

/**
 * FCY overnight used for cash Δr on the funding-swap book.
 * Long FCY earns the credit rate; a short book pays the debit / OD rate.
 */
export function fundingSwapCashFcyRate(
  standingSwap: number,
  r_FCY: number,
  r_OD?: number,
): number {
  return standingSwap < 0
    && typeof r_OD === 'number'
    && Number.isFinite(r_OD)
    ? r_OD
    : r_FCY;
}

/**
 * Deposit-rate CIP fallback ($M/yr) when the swap-points curve is missing.
 * Desk CIP P&L uses {@link fundingSwapPathFarCipUsdM} (Market data far-leg points).
 */
export function fundingSwapCipPointsUsdYr(
  swapNear: number,
  spot: number,
  r_FCY: number,
  r_USD: number,
): number {
  return fundingSwapOverlayUsdYr(swapNear, spot, r_FCY, r_USD).pointsUsdYr;
}

/**
 * Notional the funding-swap far leg is written on (M FCY).
 * Today's standing after the near — not the last cycle after a term repay
 * (that standing is 0) and not a later H* increment.
 */
export function swapFarLegNotional(
  plan: readonly { standing_swap: number }[] | undefined,
  swapNear: number,
): number {
  if (plan?.length) return plan[0]!.standing_swap;
  return swapNear;
}

/**
 * Far-leg tenor in months. Term cover: cycle of `far_leg` (M12 → 12).
 * Rolling: 1M — each cycle's outstanding is rolled at the next near.
 */
export function fundingSwapFarSettleMonths(
  plan: readonly { cycleIndex?: number; far_leg?: number }[] | undefined,
  forecastMonths = 12,
): number {
  if (!plan?.length) return Math.max(1, forecastMonths);
  const termAt = plan.findIndex(p => Math.abs(p.far_leg ?? 0) > 0.001);
  if (termAt >= 0) {
    const idx = plan[termAt]!.cycleIndex ?? termAt;
    return Math.max(1, idx + 1);
  }
  return 1;
}

const FUNDING_SWAP_MONTHS_PA = 12;

/**
 * How Swap Carry is quoted.
 *   `cip`       — FCY O/N + USD O/N + swap-market points (covering OD leftover;
 *                 deploying surplus CIP-nets to 0).
 *   `cashDelta` — cash-market carry vs USD on the standing book, no points.
 *                 Buffer Carry target steers on this number.
 */
export type FundingSwapCarryView = 'cip' | 'cashDelta';

/** Buffer Carry target is a cash-vs-USD ask — CIP would print 0 on the deploy that funds it. */
export function fundingSwapCarryViewFor(
  carryTarget: number | undefined,
  carryLayerOn = true,
): FundingSwapCarryView {
  if (!carryLayerOn) return 'cip';
  if (typeof carryTarget !== 'number' || !Number.isFinite(carryTarget)) return 'cip';
  return 'cashDelta';
}

export function fundingSwapCarryUsdYr(
  standingSwap: number,
  spot: number,
  r_FCY: number,
  r_USD: number,
  r_OD?: number,
  view: FundingSwapCarryView = 'cip',
): number {
  return view === 'cashDelta'
    ? fundingSwapCashDeltaUsdYr(standingSwap, spot, r_FCY, r_USD, r_OD)
    : fundingSwapOverlayUsdYr(standingSwap, spot, r_FCY, r_USD, r_OD).netUsdYr;
}

/**
 * Carry vs USD on the funding-swap book (the leg Buffer Carry target sizes).
 * Long FCY earns/pays r_FCY − r_USD; a short book uses r_OD (borrow FCY).
 * CIP points are excluded — they belong to the swap market, not this P&L.
 */
export function fundingSwapCashDeltaUsdYr(
  standingSwap: number,
  spot: number,
  r_FCY: number,
  r_USD: number,
  r_OD?: number,
): number {
  const fcyRate = fundingSwapCashFcyRate(standingSwap, r_FCY, r_OD);
  return standingSwap * ((fcyRate - r_USD) / 100) * spot;
}

/** One cycle's overlay as a month fraction of the annual rate (sums across M1…MT). */
export function fundingSwapMonthCarryUsdM(
  standingSwap: number,
  spot: number,
  r_FCY: number,
  r_USD: number,
  r_OD?: number,
  view: FundingSwapCarryView = 'cip',
): number {
  const annual = fundingSwapCarryUsdYr(
    standingSwap, spot, r_FCY, r_USD, r_OD, view,
  );
  return annual / FUNDING_SWAP_MONTHS_PA;
}

/** Path Swap Carry = Σ monthly overlay on each cycle's standing book. */
export function fundingSwapPathCarryUsdM(
  plan: readonly { standing_swap: number }[] | undefined,
  spot: number,
  r_FCY: number,
  r_USD: number,
  r_OD?: number,
  view: FundingSwapCarryView = 'cip',
): number | null {
  if (!plan?.length) return null;
  return plan.reduce(
    (s, p) => s + fundingSwapMonthCarryUsdM(
      p.standing_swap, spot, r_FCY, r_USD, r_OD, view,
    ),
    0,
  );
}

/** Path CIP P&L lives in fx-market-rates (`fundingSwapPathFarCipUsdM`) — far-leg swap points. */

/** Funding-swap carry legs for one currency ($M p.a.). */
export interface FundingSwapCarryLegs {
  /** Cash Δr vs USD on the standing book, Σ over the plan's cycles. */
  cashUsdM: number;
  /** FCY O/N component of that cash leg. */
  fcyOnUsdM: number;
}

/**
 * The single funding-swap carry calculation. Desk P&L (`pnlSwapCarryUsdM`) and
 * Liquidity Analytics both call this — never re-derive the legs at a call site,
 * or the two views drift on spot, on the O/N rate rule, or on annualisation.
 */
export function fundingSwapCarryLegs(input: {
  ccy: string;
  plan: readonly {
    standing_swap: number;
    far_leg?: number;
    cycleIndex?: number;
    /** Incremental leg this cycle adds — the notional a stripTerm tranche prices on. */
    swap_needed?: number;
  }[] | null | undefined;
  r_FCY: number;
  r_USD: number;
  r_OD?: number;
  /** Used when the row carries no funded strip. */
  fallbackCashUsdM?: number;
  /** Forecast / far tenor — term cash is M1 standing × this many months, not a 1M nest. */
  forecastMonths?: number;
  /**
   * Explicit structure when the caller knows it — a single-leg `term` plan and a
   * multi-leg `stripTerm` plan both carry a closing `far_leg`, so the shape alone
   * cannot tell them apart. Omit to keep the legacy far_leg-based auto-detect
   * (correct for plain `rolling` / `term` callers that never pass this).
   */
  bookingMode?: 'rolling' | 'term' | 'stripTerm';
}): FundingSwapCarryLegs {
  const fallback = input.fallbackCashUsdM ?? 0;
  const plan = input.plan;
  if (!plan?.length) return { cashUsdM: fallback, fcyOnUsdM: 0 };

  const spot = ccySpotRate(input.ccy);

  if (input.bookingMode === 'stripTerm') {
    const horizon = Math.max(1, input.forecastMonths ?? plan.length);
    let cashUsdM = 0;
    let fcyOnUsdM = 0;
    // Each leg is its OWN forward-starting tranche, priced ONCE on its own
    // incremental notional (swap_needed) at its own remaining tenor — pricing
    // the cumulative standing_swap here would re-price every earlier tranche
    // again at each later cycle's tenor too. Same reasoning as the CIP path
    // in fundingSwapPathFarCipUsdM — the two must stay on the same notional
    // or "Swap cash" and "CIP" stop being comparable numbers.
    plan.forEach((p, i) => {
      const notional = p.swap_needed ?? p.standing_swap;
      if (Math.abs(notional) < 1e-9) return;
      const tenor = Math.max(0, horizon - (p.cycleIndex ?? i));
      if (tenor < 1e-9) return;
      const frac = tenor / FUNDING_SWAP_MONTHS_PA;
      cashUsdM += fundingSwapCashDeltaUsdYr(
        notional, spot, input.r_FCY, input.r_USD, input.r_OD,
      ) * frac;
      fcyOnUsdM += notional
        * (fundingSwapCashFcyRate(notional, input.r_FCY, input.r_OD) / 100)
        * spot * frac;
    });
    return { cashUsdM, fcyOnUsdM };
  }

  const term = input.bookingMode
    ? input.bookingMode === 'term'
    : plan.some(p => Math.abs(p.far_leg ?? 0) > 0.001);
  if (term) {
    const standing = plan[0]!.standing_swap;
    const tenor = Math.max(
      fundingSwapFarSettleMonths(plan, input.forecastMonths ?? plan.length),
      input.forecastMonths ?? 0,
      plan.length,
    );
    const frac = Math.max(1, tenor) / FUNDING_SWAP_MONTHS_PA;
    const annual = fundingSwapCashDeltaUsdYr(
      standing, spot, input.r_FCY, input.r_USD, input.r_OD,
    );
    const fcyRate = fundingSwapCashFcyRate(standing, input.r_FCY, input.r_OD);
    return {
      cashUsdM: annual * frac,
      fcyOnUsdM: standing * (fcyRate / 100) * spot * frac,
    };
  }

  const cashUsdM = (() => {
    let sum = fundingSwapPathCarryUsdM(
      plan, spot, input.r_FCY, input.r_USD, input.r_OD, 'cashDelta',
    ) ?? fallback;
    const horizon = Math.max(
      plan.length,
      input.forecastMonths ?? plan.length,
    );
    if (horizon > plan.length) {
      const tail = plan[plan.length - 1]!.standing_swap;
      sum += (horizon - plan.length) * fundingSwapMonthCarryUsdM(
        tail, spot, input.r_FCY, input.r_USD, input.r_OD, 'cashDelta',
      );
    }
    return sum;
  })();
  const fcyOnUsdM = (() => {
    let sum = plan.reduce(
      (s, p) =>
        s
        + p.standing_swap
          * (fundingSwapCashFcyRate(p.standing_swap, input.r_FCY, input.r_OD) / 100)
          * spot
          / FUNDING_SWAP_MONTHS_PA,
      0,
    );
    const horizon = Math.max(
      plan.length,
      input.forecastMonths ?? plan.length,
    );
    if (horizon > plan.length) {
      const tail = plan[plan.length - 1]!.standing_swap;
      sum += (horizon - plan.length)
        * tail
        * (fundingSwapCashFcyRate(tail, input.r_FCY, input.r_OD) / 100)
        * spot
        / FUNDING_SWAP_MONTHS_PA;
    }
    return sum;
  })();
  return { cashUsdM, fcyOnUsdM };
}

/**
 * Layered buffer + swap bridge (see also optimizePortfolioCarry when portfolioDiv is on).
 *
 * Pre-funding requirement model:
 *   δ_sigma = σ_P × z × |payout|  (gross payout forecast uncertainty)
 *   δ_carry / δ_portfolio sized on |opening LP| stock
 *
 *   H_trough (what remains AFTER payout — the cushion; `cash_threshold` here):
 *     PAY:  floor + δ_sigma + δ_carry (+ δ_portfolio)      — no stock hold; sell excess
 *     EARN: max(trough, 0) + floor + δ_sigma + δ_carry (…) — hold remaining stock + cushion
 *
 *   Target LP Cash (pre-swap requirement, BEFORE payout) = H_trough − payout
 *     → payout raises Target by |payout| + σ − carry corr ± div corr
 *   Swap = Target − opening LP  (= H_trough − trough)
 *   LP+Swap = opening + swap    → achieved requirement (= Target unless clamped)
 *   Cycle End = opening + payout + swap + collections + fcast = H_trough + collections + fcast
 *     → payout-insensitive except σ/carry inside the cushion
 */
/** Outflow scale for buffer layers — only the LP gap not already covered by opening stock. */
export function netPayoutDeficit(payout_M: number, lp_cash_M: number): number {
  if (Math.abs(payout_M) <= 0.001) return 0;
  if (payout_M < -0.001 && lp_cash_M > 0.001) {
    return Math.max(0, Math.abs(payout_M) - lp_cash_M);
  }
  return Math.abs(payout_M);
}

/** PAY carry (r_FCY < r_USD): uncovered payout deficit funds via OD/USD, not positive FCY buffer. */
export function isPayCarry(r_USD: number, r_FCY: number): boolean {
  return r_USD - r_FCY > 0.05;
}

export function computeLayeredBuffer(
  P: number,               // gross |payout| — σ scale (forecast uncertainty on the full payout)
  forecasted_cash: number, // trough = lp_cash + payout — EARN stock-hold anchor
  σ_P: number,
  r_USD: number,
  r_FCY: number,
  r_OD: number,
  cash_floor: number,  // per-currency floor (M FCY), default 0
  active: Set<LayerId>,
  lp_cash_M?: number,    // opening LP — carry/portfolio scale (defaults to |trough|)
  carry_target_M?: number, // manual Target LP Cash (M FCY) — replaces the z_opt carry leg
  /** Net CFaR in FCY — exogenous FX-hedge residual; never reads the funding swap. */
  cfarCoverFcy?: number,
): LayeredBufferResult {
  const Δr = r_USD - r_FCY;
  const trough = forecasted_cash;
  const payoutScale = P > 0.001 ? P : 0;
  const payCarry = isPayCarry(r_USD, r_FCY);
  const stockScale = Math.abs(lp_cash_M ?? 0) > 0.001
    ? Math.abs(lp_cash_M!)
    : (Math.abs(trough) > 0.001 ? Math.abs(trough) : payoutScale);

  const floor_contrib = active.has('floorH') ? cash_floor : 0;

  // σ buffer = forecast uncertainty on the gross payout
  const delta_sigma = active.has('sigmaP') && payoutScale > 0.001
    ? payoutScale * σ_P * Z_NEUTRAL : 0;

  let delta_carry = 0;
  let z_opt = Z_NEUTRAL;
  // A manual carry target states the Target LP Cash directly; the layer stack is
  // expressed at the trough, so it enters as the δ_carry that reaches that target.
  // It is setup for the carry layer, so it only reaches the book once that is on.
  const manual_carry_target =
    active.has('carryOptim') && typeof carry_target_M === 'number' && Number.isFinite(carry_target_M);
  // No ask typed: the default carry level IS the Min floor stated for this currency.
  // An unset floor reads as a 0 carry tilt — the layer stays neutral and the other
  // layers stand as they are, rather than the book taking whatever z_opt prices.
  // The floor VALUE drives this on its own; the floorH toggle only controls whether
  // the floor also binds as a hard minimum further down.
  const default_carry_target =
    !manual_carry_target
    && active.has('carryOptim')
    && Math.abs(cash_floor) > 0.0001
      ? cash_floor
      : null;
  const carry_layer_neutral =
    !manual_carry_target && active.has('carryOptim') && default_carry_target === null;
  const carry_target_applied = manual_carry_target || default_carry_target !== null;
  if (carry_target_applied) {
    delta_carry = carryTargetDelta(
      manual_carry_target ? carry_target_M! : default_carry_target!,
      payoutScale, trough, floor_contrib, delta_sigma, payCarry,
    );
    z_opt = stockScale > 0.001 && σ_P > 0
      ? Z_NEUTRAL + delta_carry / (stockScale * σ_P)
      : Z_NEUTRAL;
  } else if (!carry_layer_neutral && active.has('carryOptim') && σ_P > 0 && stockScale > 0.001) {
    const raw_ratio = (Δr / 100) / ((r_OD || 0.01) / 100);
    const shortfall_prob = Math.max(0.001, Math.min(0.999, raw_ratio));
    z_opt = normInv(1 - shortfall_prob);
    delta_carry = stockScale * σ_P * (z_opt - Z_NEUTRAL);
  }

  const P_contrib = active.has('sigmaP') && payoutScale > 0.001 && !payCarry ? payoutScale : 0;
  // FX-hedge residual in FCY — a readout, never a funding-swap increment.
  // USD CFaR is P&L; FCY payment capacity is volume. Mixing them prints a
  // bogus Swap Near (and a Swap+Fwd overlay then hedges that extra S).
  const delta_cfar = active.has('cfarCover') && (cfarCoverFcy ?? 0) > 0.001
    ? cfarCoverFcy!
    : 0;
  const layerSum = floor_contrib + delta_sigma + delta_carry;
  const hold = payCarry ? layerSum : Math.max(trough, 0) + layerSum;
  const raw_sum = hold;

  const noNeg = applyNoNegativeLpFloor(raw_sum, r_OD, r_USD);
  // Hard minimum: with the floor layer on, the trough cushion never drops below cash_floor.
  const cash_threshold = applyHardMinFloor(noNeg.cash_threshold, floor_contrib);
  const debit_floor_binding = noNeg.debit_floor_binding;
  const floor_binding = floor_contrib > 0.001 && layerSum < floor_contrib - 0.001;

  return {
    P_contrib, floor_contrib, delta_sigma, delta_carry, delta_cfar, raw_sum, cash_threshold, floor_binding, z_opt,
    carry_dir: Δr > 0.05 ? 'pay' : Δr < -0.05 ? 'earn' : 'neutral',
    delta_r: Δr,
    debit_floor_binding,
    carry_target_applied,
    carry_target_binding: carry_target_applied && Math.abs(cash_threshold - raw_sum) > 0.001,
  };
}

/**
 * δ_carry that lands the trough cushion on a manually stated Target LP Cash.
 *
 * Target is quoted pre-payout (opening + swap), while the layer stack is built at
 * the trough, so the requested cushion is `target − |payout|`. PAY carry sells the
 * held stock down to the cushion; EARN carry stacks on top of what survives.
 */
export function carryTargetDelta(
  carry_target_M: number,
  payoutScale: number,
  trough: number,
  floor_contrib: number,
  delta_sigma: number,
  payCarry: boolean,
): number {
  const desiredCushion = carry_target_M - payoutScale;
  return desiredCushion - floor_contrib - delta_sigma - (payCarry ? 0 : Math.max(trough, 0));
}

/**
 * USD liquidity target — funding currency; no carry or portfolio legs.
 *
 * H_USD = |payout| + floor + σ_P×z₉₅×|payout| when sigmaP on.
 * With no USD payout and no floor → 0 (excess USD is not "sold" via swap).
 * carryOptim and portfolioDiv are intentionally ignored for USD.
 */
export function computeUsdBuffer(
  payout_M: number,
  cash_floor: number,
  σ_P: number,
  active: Set<LayerId>,
): LayeredBufferResult {
  const payoutScale = Math.abs(payout_M) > 0.001 ? Math.abs(payout_M) : 0;

  const floor_contrib = active.has('floorH') ? cash_floor : 0;
  const delta_sigma = active.has('sigmaP') && payoutScale > 0 ? payoutScale * σ_P * Z_NEUTRAL : 0;
  const P_contrib = active.has('sigmaP') && payoutScale > 0 ? payoutScale : 0;

  const raw_sum = P_contrib + floor_contrib + delta_sigma;
  const cash_threshold = raw_sum;
  const floor_binding = floor_contrib > 0.001 && raw_sum < floor_contrib;

  return {
    P_contrib, floor_contrib, delta_sigma, delta_carry: 0, delta_cfar: 0, raw_sum, cash_threshold, floor_binding,
    z_opt: Z_NEUTRAL, carry_dir: 'neutral', delta_r: 0, debit_floor_binding: false,
  };
}
/** True when FCY debit exceeds USD LP credit — planned LP deficit is prohibitive. */
export function isExpensiveOverdraft(r_OD: number, r_USD: number): boolean {
  return r_OD > r_USD + 1e-6;
}

/** Negative LP allowed when FCY debit is cheaper than holding USD (r_OD ≤ r_USD). */
export function allowsNegativeLp(r_OD: number, r_USD: number): boolean {
  return !isExpensiveOverdraft(r_OD, r_USD);
}

/**
 * Hard per-currency minimum: with the floor layer on and a positive floor set,
 * the target/cushion never drops below it (through any regime — carry sell-down,
 * portfolio overlay, or USD stress). Zero/negative floors keep additive behavior.
 */
export function applyHardMinFloor(cash_threshold: number, floor_contrib: number): number {
  return floor_contrib > 0.001 ? Math.max(cash_threshold, floor_contrib) : cash_threshold;
}

/** Floor H* at 0 when r_OD > r_USD — borrowing FCY costs more than USD credit. */
export function applyNoNegativeLpFloor(
  cash_threshold: number,
  r_OD: number,
  r_USD: number,
): { cash_threshold: number; debit_floor_binding: boolean } {
  if (allowsNegativeLp(r_OD, r_USD)) {
    return { cash_threshold, debit_floor_binding: false };
  }
  return {
    cash_threshold: Math.max(0, cash_threshold),
    debit_floor_binding: cash_threshold < -1e-6,
  };
}

/** Swap cannot drive pre-payout LP cash below zero when r_OD > r_USD. */
export function clampSwapNoNegativeCash(
  swapNear: number,
  cashPos: number,
  r_OD: number,
  r_USD: number,
): number {
  if (allowsNegativeLp(r_OD, r_USD)) return swapNear;
  return Math.max(swapNear, -cashPos);
}

/**
 * FCY swap near leg — bridge trough (LP + payout) to pre-swap H*. Invoice fcast
 * is Cycle End only.
 *
 * With no layer selected there is no liquidity rule to satisfy, so the desk
 * holds the book: the swap is silent and a trough left below zero stays a
 * structural gap, priced through carry at the overdraft rate rather than
 * funded by a recommendation the policy never asked for.
 */
export function computeFcySwapNear(
  cash_threshold: number,
  cashPos: number,
  _fcastFX: number,
  r_OD: number,
  r_USD: number,
  formulaLayersActive: boolean,
  troughCash_M: number,
): number {
  if (!formulaLayersActive) return 0;
  return clampSwapNoNegativeCash(cash_threshold - troughCash_M, cashPos, r_OD, r_USD);
}


/** Layers that apply to USD — floor + payout σ buffer only. */
export function usdActiveLayers(active: Set<LayerId>): Set<LayerId> {
  const usd = new Set<LayerId>();
  if (active.has('floorH')) usd.add('floorH');
  if (active.has('sigmaP')) usd.add('sigmaP');
  return usd;
}

/** Sum FCY swap near legs in USD (excludes USD row). Positive = buy FCY / fund from USD. */
export function sumFcySwapNearUsd(swaps: { ccy: string; swapNear: number }[]): number {
  return swaps
    .filter(s => s.ccy !== 'USD')
    .reduce((sum, s) => {
      const spot = CURRENCY_PARAMS[s.ccy]?.spot ?? 0;
      return sum + s.swapNear * spot;
    }, 0);
}

export interface UsdLiquidityResult {
  payout_buffer: number;
  fcy_swap_usd: number;
  /** Target LP USD cash at trough (payout buffer, or maintain peak when no USD payout). */
  cash_threshold: number;
  /** USD peak LP cash before swap (cash + payout). */
  usd_peak: number;
  /** Max net FCY buy in USD implied by USD target: peak − H_USD. */
  implied_fcy_swap_usd: number;
  /** Swap to reach USD target: H_USD − peak (same pattern as FCY threshold − cashPos). */
  swapNear: number;
  usd_cash_M: number;
  reserved_for_payout: number;
  available_for_fcy: number;
  fcy_funding_shortfall: number;
  /** FCY net USD vs signed implied envelope (fcy − implied). */
  fcy_envelope_gap: number;
  /** FCY net USD funding exceeds envelope allowed by USD target. */
  fcy_envelope_shortfall: number;
  budget_binding: boolean;
}

/**
 * USD LP cash target — defined in USD first, before FCY layer targets.
 * When a payout σ buffer exists, H_USD = that buffer; otherwise maintain current peak.
 */
export function computeUsdLiquidityTarget(
  payoutBuffer_M: number,
  usdPeak_M: number,
  formulaLayersActive: boolean,
): number {
  if (!formulaLayersActive) return usdPeak_M;
  if (payoutBuffer_M > 0.001) return payoutBuffer_M;
  return usdPeak_M;
}

/**
 * USD liquidity — FCY swaps fund from / pay to USD; USD leg is the mechanical offset.
 * swapNear = −Σ(FCY swap × spot). H_USD is the payout σ reserve target only.
 */
export function deriveUsdLiquidity(
  payoutBuffer_M: number,
  fcySwapNearUsd_M: number,
  usdCash_M: number,
  usdPayout_M = 0,
  formulaLayersActive = true,
): UsdLiquidityResult {
  const usd_peak = usdCash_M + usdPayout_M;
  const reserved_for_payout = payoutBuffer_M;
  const cash_threshold = computeUsdLiquidityTarget(payoutBuffer_M, usd_peak, formulaLayersActive);
  /** FCY net swap $USD — each FCY leg consumes USD (buy) or pays USD (sell). */
  const implied_fcy_swap_usd = formulaLayersActive ? usd_peak - cash_threshold : 0;

  /** USD leg is always the mechanical offset of FCY swaps. */
  const swapNear = -fcySwapNearUsd_M;

  const available_for_fcy = Math.max(0, usd_peak - reserved_for_payout);
  const fcy_funding_need = Math.max(0, fcySwapNearUsd_M);
  const fcy_funding_shortfall = Math.max(0, fcy_funding_need - available_for_fcy);
  const fcy_envelope_gap = formulaLayersActive
    ? fcySwapNearUsd_M - implied_fcy_swap_usd
    : 0;
  /** Envelope binds only when USD payout defines H_USD ≠ peak — not when implied = 0. */
  const fcy_envelope_shortfall = Math.abs(implied_fcy_swap_usd) > 0.001
    ? Math.abs(fcy_envelope_gap)
    : 0;

  return {
    payout_buffer: payoutBuffer_M,
    fcy_swap_usd: fcySwapNearUsd_M,
    cash_threshold,
    usd_peak,
    implied_fcy_swap_usd,
    swapNear,
    usd_cash_M: usdCash_M,
    reserved_for_payout,
    available_for_fcy,
    fcy_funding_shortfall,
    fcy_envelope_gap,
    fcy_envelope_shortfall,
    budget_binding: fcy_funding_shortfall > 0.001 || fcy_envelope_shortfall > 0.001,
  };
}

/** USD LP cash available to collateralise FCY buffers after reserving payout σ buffer. */
export function computeFcyCollateralBudget(
  usdCash_M: number,
  usdPayoutBuffer_M: number,
): number {
  return Math.max(0, usdCash_M - usdPayoutBuffer_M);
}

export interface UsdLiquidityAssessment {
  payout_buffer: number;
  usd_cash_M: number;
  /** USD cash short of payout reservation */
  usd_payout_gap: number;
  available_for_fcy: number;
  /** 'normal' = full optimization; 'stress' = FCY targets force-trimmed */
  mode: 'normal' | 'stress';
}

/** Step 1 — USD priority: reserve payout buffer before FCY collateral. */
export function assessUsdLiquidityPriority(
  usdCash_M: number,
  usdPayoutBuffer_M: number,
): UsdLiquidityAssessment {
  return {
    payout_buffer: usdPayoutBuffer_M,
    usd_cash_M: usdCash_M,
    usd_payout_gap: Math.max(0, usdPayoutBuffer_M - usdCash_M),
    available_for_fcy: computeFcyCollateralBudget(usdCash_M, usdPayoutBuffer_M),
    mode: 'normal',
  };
}

/** Minimum H* under USD liquidity stress — payout buffer only for EARN; keep PAY when r_OD ≤ r_USD. */
export function payoutLiquidityMinimum(
  P_contrib: number,
  floor_contrib: number,
  delta_sigma: number,
  r_OD: number,
  r_USD: number,
  _delta_cfar = 0,
): number {
  const raw = P_contrib + floor_contrib + delta_sigma;
  return applyNoNegativeLpFloor(raw, r_OD, r_USD).cash_threshold;
}

function carryDirFromDeltaR(r_USD: number, r_FCY: number): 'earn' | 'pay' | 'neutral' {
  const Δr = r_USD - r_FCY;
  if (Δr < -0.05) return 'earn';
  if (Δr > 0.05) return 'pay';
  return 'neutral';
}

/** Floor H* when USD liquidity binds — trim EARN first; PAY kept when r_OD ≤ r_USD. */
export function usdStressTrimFloor(
  row: {
    P_contrib: number;
    floor_contrib: number;
    delta_sigma: number;
    delta_cfar?: number;
    r_FCY: number;
    r_OD: number;
  },
  optimizedTh: number,
  r_USD: number,
): number {
  const payoutMin = payoutLiquidityMinimum(
    row.P_contrib, row.floor_contrib, row.delta_sigma, row.r_OD, r_USD, row.delta_cfar ?? 0,
  );
  const dir = carryDirFromDeltaR(r_USD, row.r_FCY);

  if (dir === 'earn') return payoutMin;
  if (dir === 'pay' && isExpensiveOverdraft(row.r_OD, r_USD)) return payoutMin;
  if (dir === 'pay' && allowsNegativeLp(row.r_OD, r_USD)) return optimizedTh;
  return payoutMin;
}

function usdStressTrimPriority(
  row: { r_FCY: number; r_OD: number },
  r_USD: number,
): number {
  const dir = carryDirFromDeltaR(r_USD, row.r_FCY);
  if (dir === 'earn') return 0;
  if (isExpensiveOverdraft(row.r_OD, r_USD)) return 1;
  return 2;
}

function paySellIntoUsdPriority(
  row: { r_FCY: number; r_OD: number },
  r_USD: number,
): number {
  const dir = carryDirFromDeltaR(r_USD, row.r_FCY);
  if (dir === 'pay') return 0;
  if (dir === 'neutral') return 1;
  return 2;
}

export interface FcyStressRow {
  ccy: string;
  cash_threshold: number;
  total_cash: number;
  cash: number;
  payout: number;
  /**
   * Low the swap sizes against — the funded plan's sizing trough when the dated
   * liquidity path is on, otherwise `cash + payout`. Passed in rather than
   * re-derived here: recomputing it as `cash + payout` would silently drop the
   * dated path and the horizon basis, so a trimmed row would size on a different
   * low than the row the simulator shows.
   */
  trough_lp: number;
  /**
   * Leg the funded plan books, when the desk books its cover as one term swap:
   * sized to carry every cycle of the horizon, not this cycle's shortfall. Set,
   * it IS the leg — re-deriving it from the target here would report a smaller
   * trade than the plan executes.
   */
  planned_near_leg?: number;
  P_contrib: number;
  floor_contrib: number;
  delta_sigma: number;
  delta_cfar?: number;
  r_FCY: number;
  r_OD: number;
}

export interface FcyStressResult extends FcyStressRow {
  swap_needed: number;
  usd_stress_trim: boolean;
  stress_trim_from?: number;
}

/**
 * When FCY buy demand exceeds USD collateral, or USD payout requires FCY envelope
 * (H_USD ≠ peak), trim/rebalance FCY targets. USD swap stays −Σ(FCY swap $USD).
 */
export function enforceUsdLiquidityStress(
  rows: FcyStressRow[],
  usdCash_M: number,
  usdPayoutBuffer_M: number,
  r_USD: number,
  formulaLayersActive: boolean,
  usdPayout_M = 0,
): {
  rows: FcyStressResult[];
  fcySwapNearUsd: number;
  usdLiquidity: UsdLiquidityResult;
  stress_binding: boolean;
} {
  const thresholds = new Map(rows.map(r => [r.ccy, r.cash_threshold]));
  const optimized = new Map(rows.map(r => [r.ccy, r.cash_threshold]));
  const ENVELOPE_TOL = 0.001;
  const maxIterations = rows.length * 24;

  function buildResults(): FcyStressResult[] {
    return rows.map(row => {
      const th = thresholds.get(row.ccy)!;
      const optTh = optimized.get(row.ccy)!;
      const swap_needed = row.planned_near_leg ?? computeFcySwapNear(
        th, row.total_cash, 0, row.r_OD, r_USD, formulaLayersActive, row.trough_lp,
      );
      const trimmed = Math.abs(th - optTh) > 0.001;
      return {
        ...row,
        cash_threshold: th,
        swap_needed,
        usd_stress_trim: trimmed,
        stress_trim_from: trimmed ? optTh : undefined,
      };
    });
  }

  function liquidityFrom(results: FcyStressResult[]): UsdLiquidityResult {
    const fcyUsd = sumFcySwapNearUsd(results.map(r => ({ ccy: r.ccy, swapNear: r.swap_needed })));
    return deriveUsdLiquidity(
      usdPayoutBuffer_M, fcyUsd, usdCash_M, usdPayout_M, formulaLayersActive,
    );
  }

  function shortfallFrom(results: FcyStressResult[]): number {
    const d = liquidityFrom(results);
    return Math.max(d.fcy_funding_shortfall, d.fcy_envelope_shortfall);
  }

  function fundingTrimFloor(row: FcyStressRow): number {
    return payoutLiquidityMinimum(
      row.P_contrib, row.floor_contrib, row.delta_sigma, row.r_OD, r_USD, row.delta_cfar ?? 0,
    );
  }

  function trimDownOne(forFunding: boolean): boolean {
    const trimCandidates = [...rows].sort((a, b) => {
      const pa = usdStressTrimPriority(a, r_USD);
      const pb = usdStressTrimPriority(b, r_USD);
      if (pa !== pb) return pa - pb;
      const floorA = forFunding
        ? fundingTrimFloor(a)
        : usdStressTrimFloor(a, optimized.get(a.ccy)!, r_USD);
      const floorB = forFunding
        ? fundingTrimFloor(b)
        : usdStressTrimFloor(b, optimized.get(b.ccy)!, r_USD);
      const excessA = Math.max(0, thresholds.get(a.ccy)! - floorA) * (CURRENCY_PARAMS[a.ccy]?.spot ?? 0);
      const excessB = Math.max(0, thresholds.get(b.ccy)! - floorB) * (CURRENCY_PARAMS[b.ccy]?.spot ?? 0);
      return excessB - excessA;
    });

    for (const row of trimCandidates) {
      const dir = carryDirFromDeltaR(r_USD, row.r_FCY);
      if (!forFunding && dir === 'pay' && isExpensiveOverdraft(row.r_OD, r_USD)) continue;
      const current = thresholds.get(row.ccy)!;
      const optTh = optimized.get(row.ccy)!;
      const floor = forFunding ? fundingTrimFloor(row) : usdStressTrimFloor(row, optTh, r_USD);
      if (current <= floor + ENVELOPE_TOL) continue;
      thresholds.set(row.ccy, floor);
      return true;
    }
    return false;
  }

  function sellPayIntoUsdOne(liq: UsdLiquidityResult): boolean {
    const gap = liq.fcy_envelope_gap;
    if (gap <= ENVELOPE_TOL || liq.implied_fcy_swap_usd >= -ENVELOPE_TOL) return false;

    const candidates = [...rows]
      .filter(row => carryDirFromDeltaR(r_USD, row.r_FCY) === 'pay')
      .map(row => {
        const current = thresholds.get(row.ccy)!;
        const floor = fundingTrimFloor(row);
        const headroom = Math.max(0, current - floor);
        const spot = CURRENCY_PARAMS[row.ccy]?.spot ?? 0;
        return { row, headroom, spot, floor };
      })
      .filter(c => c.headroom > ENVELOPE_TOL && c.spot > ENVELOPE_TOL)
      .sort((a, b) => {
        const pa = isExpensiveOverdraft(a.row.r_OD, r_USD) ? 1 : 0;
        const pb = isExpensiveOverdraft(b.row.r_OD, r_USD) ? 1 : 0;
        if (pa !== pb) return pa - pb;
        return b.headroom * b.spot - a.headroom * a.spot;
      });

    if (candidates.length === 0) return false;
    const { row, headroom, spot, floor } = candidates[0];
    const current = thresholds.get(row.ccy)!;
    const fcyStep = Math.min(gap / spot, headroom);
    thresholds.set(row.ccy, Math.max(floor, current - fcyStep));
    return Math.abs(thresholds.get(row.ccy)! - current) > ENVELOPE_TOL;
  }

  function sellPayToFloorOne(): boolean {
    const candidates = [...rows]
      .filter(row => carryDirFromDeltaR(r_USD, row.r_FCY) === 'pay')
      .map(row => {
        const current = thresholds.get(row.ccy)!;
        const floor = fundingTrimFloor(row);
        const headroom = Math.max(0, current - floor);
        return { row, headroom, spot: CURRENCY_PARAMS[row.ccy]?.spot ?? 0, floor };
      })
      .filter(c => c.headroom > ENVELOPE_TOL)
      .sort((a, b) => {
        const pa = paySellIntoUsdPriority(a.row, r_USD);
        const pb = paySellIntoUsdPriority(b.row, r_USD);
        if (pa !== pb) return pa - pb;
        return b.headroom * b.spot - a.headroom * a.spot;
      });
    if (candidates.length === 0) return false;
    thresholds.set(candidates[0].row.ccy, candidates[0].floor);
    return true;
  }

  function trimEarnExcessOne(): boolean {
    const trimCandidates = [...rows]
      .filter(row => carryDirFromDeltaR(r_USD, row.r_FCY) !== 'pay')
      .sort((a, b) => {
        const pa = usdStressTrimPriority(a, r_USD);
        const pb = usdStressTrimPriority(b, r_USD);
        if (pa !== pb) return pa - pb;
        const floorA = usdStressTrimFloor(a, optimized.get(a.ccy)!, r_USD);
        const floorB = usdStressTrimFloor(b, optimized.get(b.ccy)!, r_USD);
        const excessA = Math.max(0, thresholds.get(a.ccy)! - floorA) * (CURRENCY_PARAMS[a.ccy]?.spot ?? 0);
        const excessB = Math.max(0, thresholds.get(b.ccy)! - floorB) * (CURRENCY_PARAMS[b.ccy]?.spot ?? 0);
        return excessB - excessA;
      });

    for (const row of trimCandidates) {
      const current = thresholds.get(row.ccy)!;
      const optTh = optimized.get(row.ccy)!;
      const floor = usdStressTrimFloor(row, optTh, r_USD);
      if (current <= floor + ENVELOPE_TOL) continue;
      thresholds.set(row.ccy, floor);
      return true;
    }
    return false;
  }

  function increaseSellOne(): boolean {
    const candidates = [...rows]
      .map(row => {
        const current = thresholds.get(row.ccy)!;
        const optTh = optimized.get(row.ccy)!;
        const floor = usdStressTrimFloor(row, optTh, r_USD);
        const headroom = Math.max(0, current - floor);
        return { row, headroom, spot: CURRENCY_PARAMS[row.ccy]?.spot ?? 0 };
      })
      .filter(c => c.headroom > ENVELOPE_TOL)
      .sort((a, b) => b.headroom * b.spot - a.headroom * a.spot);
    if (candidates.length === 0) return false;
    const { row, floor } = {
      row: candidates[0].row,
      floor: usdStressTrimFloor(candidates[0].row, optimized.get(candidates[0].row.ccy)!, r_USD),
    };
    thresholds.set(row.ccy, floor);
    return true;
  }

  function reduceSellOne(): boolean {
    const candidates = buildResults()
      .filter(r => r.swap_needed < -ENVELOPE_TOL)
      .map(r => {
        const current = thresholds.get(r.ccy)!;
        const optTh = optimized.get(r.ccy)!;
        return { row: r, gap: optTh - current, spot: CURRENCY_PARAMS[r.ccy]?.spot ?? 0 };
      })
      .filter(c => c.gap > ENVELOPE_TOL)
      .sort((a, b) => b.gap * b.spot - a.gap * a.spot);
    if (candidates.length === 0) return false;
    thresholds.set(candidates[0].row.ccy, optimized.get(candidates[0].row.ccy)!);
    return true;
  }

  function increaseBuyOne(): boolean {
    const candidates = [...rows]
      .map(row => {
        const current = thresholds.get(row.ccy)!;
        const optTh = optimized.get(row.ccy)!;
        return { row, gap: optTh - current, spot: CURRENCY_PARAMS[row.ccy]?.spot ?? 0 };
      })
      .filter(c => c.gap > ENVELOPE_TOL)
      .sort((a, b) => b.gap * b.spot - a.gap * a.spot);
    if (candidates.length === 0) return false;
    thresholds.set(candidates[0].row.ccy, optimized.get(candidates[0].row.ccy)!);
    return true;
  }

  function emergencyUsdFundingStep(liq: UsdLiquidityResult): boolean {
    const gap = liq.fcy_envelope_gap;
    if (gap <= ENVELOPE_TOL || liq.implied_fcy_swap_usd >= -ENVELOPE_TOL) return false;
    const candidates = [...rows]
      .filter(row => allowsNegativeLp(row.r_OD, r_USD))
      .map(row => ({
        row,
        spot: CURRENCY_PARAMS[row.ccy]?.spot ?? 0,
        current: thresholds.get(row.ccy)!,
      }))
      .filter(c => c.spot > ENVELOPE_TOL)
      .sort((a, b) => b.spot - a.spot);
    if (candidates.length === 0) return false;
    const { row, spot, current } = candidates[0];
    // Emergency funding may go negative, but never below the enabled min floor.
    const next = applyHardMinFloor(current - gap / spot, row.floor_contrib);
    if (Math.abs(next - current) <= ENVELOPE_TOL) return false;
    thresholds.set(row.ccy, next);
    return true;
  }

  let results = buildResults();
  let shortfall = shortfallFrom(results);

  // Term legs are sized by the plan against the whole horizon, so trimming this
  // cycle's target does not make them smaller — the search has no lever to pull
  // and would only walk every target down to its floor for nothing. The budget
  // verdict still prices the trade; the answer to it is a smaller plan, which the
  // next target pass builds.
  const legsPinned = rows.length > 0 && rows.every(r => r.planned_near_leg !== undefined);

  if (shortfall < ENVELOPE_TOL || legsPinned) {
    const liq = liquidityFrom(results);
    return { rows: results, fcySwapNearUsd: liq.fcy_swap_usd, usdLiquidity: liq, stress_binding: false };
  }

  const initLiq = liquidityFrom(results);
  const fundingOnlyStress = Math.abs(initLiq.implied_fcy_swap_usd) <= ENVELOPE_TOL
    && initLiq.fcy_funding_shortfall > ENVELOPE_TOL;

  let stress_binding = false;
  for (let iter = 0; iter < maxIterations && shortfall >= ENVELOPE_TOL; iter++) {
    const liq = liquidityFrom(results);
    if (fundingOnlyStress && liq.fcy_funding_shortfall < ENVELOPE_TOL) break;

    const signedEnvelope = Math.abs(liq.implied_fcy_swap_usd) > ENVELOPE_TOL;
    const gap = liq.fcy_envelope_gap;
    let stepped = false;

    if (liq.fcy_funding_shortfall > ENVELOPE_TOL) {
      stepped = trimDownOne(true);
    } else if (signedEnvelope) {
      if (gap > ENVELOPE_TOL) {
        /** USD payout envelope: sell low-yield PAY into USD before touching EARN longs. */
        stepped = sellPayIntoUsdOne(liq);
        if (!stepped) stepped = sellPayToFloorOne();
        if (!stepped) stepped = emergencyUsdFundingStep(liq);
        if (!stepped) stepped = trimEarnExcessOne();
      } else if (gap < -ENVELOPE_TOL) {
        stepped = liq.implied_fcy_swap_usd < -ENVELOPE_TOL ? reduceSellOne() : increaseBuyOne();
      }
      if (!stepped) stepped = emergencyUsdFundingStep(liq);
    }

    if (!stepped) break;
    stress_binding = true;
    results = buildResults();
    shortfall = shortfallFrom(results);
  }

  const usdLiquidity = liquidityFrom(results);
  return {
    rows: results,
    fcySwapNearUsd: usdLiquidity.fcy_swap_usd,
    usdLiquidity: { ...usdLiquidity, budget_binding: usdLiquidity.budget_binding },
    stress_binding,
  };
}

/** @deprecated Use deriveUsdLiquidity */
export function deriveUsdFromFcySwaps(
  payoutBuffer_M: number,
  fcySwapNearUsd_M: number,
  usdPeak_M?: number,
): { cash_threshold: number; swapNear: number; payout_buffer: number; fcy_swap_usd: number } {
  const peak = usdPeak_M ?? payoutBuffer_M;
  const d = deriveUsdLiquidity(payoutBuffer_M, fcySwapNearUsd_M, peak, 0, true);
  return {
    payout_buffer: d.payout_buffer,
    fcy_swap_usd: d.fcy_swap_usd,
    cash_threshold: d.cash_threshold,
    swapNear: d.swapNear,
  };
}

// ── Portfolio-level carry optimizer ──────────────────────────────────────
//
// Builds the carry overlay that FILLS the portfolio VAR budget when
// portfolioDiv + carryOptim are both active — so a bigger limit produces
// proportionally bigger overlays across every currency instead of freezing
// at a fixed prudential optimum.
//
// Per currency i:
//   base_i = max(trough_i, 0) + floor + σ cushion   (hold-the-book neutral)
//   dir_i  = carry tilt DIRECTION (PAY → sell δ<0, EARN → buy δ>0), sized by
//            |LP_i| × σ_P × (z_opt − z_neutral)
//   H_i(s) = base_i + s × dir_i                     (single portfolio scale s)
//
// Policy VAR is charged on the OVERLAY (H − base) — the P&L fluctuation of the
// discretionary carry positions — never on pre-existing holdings. The largest
// s with Overlay_VAR ≤ policyVAR_M is used, so the FULL budget becomes carry.
// A second bisection caps s down only if the NET overlay USD draw (EARN buys
// minus PAY sell proceeds) exceeds the USD collateral budget — the book is
// largely self-funding, so this rarely binds before the VAR limit does.
// Because a single s multiplies dir for ALL currencies, PAY and EARN positions
// (and their swap overlays) scale uniformly with the limit.

export interface PortfolioCarryInput {
  ccy: string;
  P: number;                // |payout| M FCY — payout-scaled carry only
  lp_cash: number;          // LP cash stock (M FCY) — portfolio stock reallocation scale
  P_contrib: number;        // P when sigmaP was active (else 0)
  forecasted_cash: number;  // trough = lp_cash + payout (anchor for H*)
  floor_contrib: number;    // floor contribution already computed (floorH layer)
  delta_sigma: number;      // safety margin already computed (sigmaP layer)
  /** FX-hedge Net CFaR — readout only; not part of the FCY hold-the-book base. */
  delta_cfar?: number;
  r_FCY: number;            // % p.a.
  r_OD: number;             // % p.a.
  /** Manual Target LP Cash (M FCY) — when set it defines the overlay direction. */
  carry_target?: number;
}

export interface PortfolioCarryResult {
  ccy: string;
  delta_carry: number;      // carry Δ on |lp_cash| stock scale (before USD budget scale on EARN)
  delta_portfolio: number;  // same leg after PAY→USD funding scale (± adjustment on trough)
  /** Hold-the-book neutral position (max(trough,0) + floor + σ) — VAR is charged on deviations from this. */
  base_hold: number;
  cash_threshold: number;   // base_hold + delta_portfolio (overlay)
  /** Target before expensive-OD floor at 0 (equals cash_threshold when not floored). */
  cash_threshold_raw?: number;
  debit_floor_binding?: boolean;
  z_opt: number;            // z-score used for stock leg
  lambda: number;           // Lagrange multiplier for VAR constraint
  lambda_usd: number;       // Lagrange multiplier for USD budget constraint
  constrained: boolean;
  var_binding: boolean;
  budget_binding: boolean;
  carry_dir: 'earn' | 'pay' | 'neutral';
  delta_r: number;          // r_USD − r_FCY
  /**
   * Single per-currency answer to "why did this overlay get capped", in the
   * order the optimizer actually trims (floor first, then USD budget, which
   * overrides a VAR trim when both would otherwise apply — see the budget
   * bisection above, which sets `varBinding = false` the moment it runs).
   * `null` = this currency's carry tilt is unconstrained.
   */
  binding_reason: 'floor' | 'usdBudget' | 'varCap' | null;
  /**
   * This currency's share of total portfolio VAR from its own overlay leg
   * ($M) — the "why this number" figure: how much of the shared policy VAR
   * budget this position uses, or (negative) how much it diversifies away.
   */
  component_var_usd: number;
  /** True when this row's target came from a desk-typed Target LP Cash, not the optimizer. */
  manual: boolean;
}

/** USD LP balance available to collateralise FCY buffers after USD outflows. */
export function computeEffectiveUsdBudget(usdCash_M: number, usdPayout_M: number): number {
  return Math.max(0, usdCash_M + Math.min(0, usdPayout_M));
}

// ─── helpers used in optimizePortfolioCarry ──────────────────────────────────

/** Carry delta for a given scale using Lagrangian penalties (λ_var, λ_usd). */
function carryDeltaAt(
  scale: number, Δr: number, r_OD: number, σ_P: number,
  β: number, λ_var: number, λ_usd: number,
): { delta: number; z_opt: number } {
  if (scale <= 0.001 || σ_P <= 0) return { delta: 0, z_opt: Z_NEUTRAL };
  const penalty = 100 * (λ_var * β + λ_usd);
  let eff_Δr = Δr;
  if (Δr > 0.05) eff_Δr = Math.max(0.001, Δr - penalty);
  else if (Δr < -0.05) eff_Δr = Math.min(-0.001, Δr + penalty);
  const sp     = Math.max(0.001, Math.min(0.999, eff_Δr / (r_OD || 0.01)));
  const z_opt  = normInv(1 - sp);
  return { delta: scale * σ_P * (z_opt - Z_NEUTRAL), z_opt };
}

export interface PortfolioVarCapInput {
  ccy: string;
  cash_threshold: number;
  /** Hold-the-book neutral position — VAR is charged on deviations from this, never on the base itself. */
  liquidity_base: number;
  trough_lp: number;
  /** Leg the plan books under term cover — see `FcyStressRow.planned_near_leg`. */
  planned_near_leg?: number;
  total_cash: number;
  cash: number;
  payout: number;
  r_OD: number;
}

export interface PortfolioVarCapResult extends PortfolioVarCapInput {
  swap_needed: number;
  var_trim: boolean;
  var_trim_from?: number;
}

/**
 * Cap the OVERLAY VAR (deviation of targets from the hold-the-book base) at
 * policyVAR. Runs after USD stress trim; scales overlay legs uniformly toward
 * the base — existing holdings (the base) are never liquidated by this cap.
 */
export function enforcePortfolioVarCap(
  rows: PortfolioVarCapInput[],
  policyVAR_M: number,
  r_USD: number,
  formulaLayersActive: boolean,
): {
  rows: PortfolioVarCapResult[];
  portfolio_VAR_USD: number;
  var_binding: boolean;
  scale: number;
} {
  if (rows.length === 0) {
    return { rows: [], portfolio_VAR_USD: 0, var_binding: false, scale: 1 };
  }

  const scaledThresholds = (s: number) => rows.map(
    r => r.liquidity_base + s * (r.cash_threshold - r.liquidity_base),
  );

  const overlayVarAt = (thresholds: number[]) => computePortfolioVAR(
    rows.map((r, i) => ({ ccy: r.ccy, cashFCY: thresholds[i] - r.liquidity_base })),
  ).portfolio_VAR_USD;

  const current = rows.map(r => r.cash_threshold);
  const currentVar = overlayVarAt(current);

  if (currentVar <= policyVAR_M + 1e-6) {
    return {
      rows: rows.map(r => ({
        ...r,
        swap_needed: r.planned_near_leg ?? computeFcySwapNear(
          r.cash_threshold, r.total_cash, 0, r.r_OD, r_USD, formulaLayersActive, r.trough_lp,
        ),
        var_trim: false,
      })),
      portfolio_VAR_USD: currentVar,
      var_binding: false,
      scale: 1,
    };
  }

  // Overlay VAR is proportional to the uniform deviation scale — bisect s∈[0,1].
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (overlayVarAt(scaledThresholds(mid)) > policyVAR_M) hi = mid;
    else lo = mid;
  }
  const final = scaledThresholds(lo);
  const finalVar = overlayVarAt(final);
  const trimmedAny = final.some((th, i) => Math.abs(th - rows[i].cash_threshold) > 0.001);

  return {
    rows: rows.map((r, i) => {
      const th = final[i];
      const trimmed = Math.abs(th - r.cash_threshold) > 0.001;
      return {
        ...r,
        cash_threshold: th,
        swap_needed: r.planned_near_leg ?? computeFcySwapNear(
          th, r.total_cash, 0, r.r_OD, r_USD, formulaLayersActive, r.trough_lp,
        ),
        var_trim: trimmed,
        var_trim_from: trimmed ? r.cash_threshold : undefined,
      };
    }),
    portfolio_VAR_USD: finalVar,
    var_binding: trimmedAny,
    scale: lo,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//
// optimizePortfolioCarry — overlay-VAR budget-filling carry optimizer
//
//   base_i    = max(trough_i, 0) + floor + σ cushion      (hold the book)
//   dir_i     = carry tilt direction (PAY δ<0 sell / EARN δ>0 buy)
//   H_i(s)    = floor(base_i + s × dir_i)                 (single scale s)
//   Swap_i    = H_i − trough_i
//
//   Policy VAR is charged on the OVERLAY legs (H − base), i.e. the P&L
//   fluctuation created by discretionary carry positions — NOT on existing
//   holdings. Choose the largest s with Overlay_VAR(s) ≤ policyVAR_M, then
//   cap s down if the net overlay USD draw (EARN buys − PAY sell proceeds)
//   exceeds usdBudget_M.
//
// Unpinned overlays follow Σ⁻¹μ (shared VAR + shared carry). One k scales
// that ray to the policy VAR cap, or to a feasible portfolio carry ask.
// USD swap leg (outside optimizer): swap_USD = −Σ(FCY swap × spot).
//
export function optimizePortfolioCarry(
  inputs: PortfolioCarryInput[],
  σ_P: number,
  r_USD: number,
  policyVAR_M: number,
  usdBudget_M: number = Infinity,
  payoutCarry = true,
  carryTargetUsdYrM?: number,
  /**
   * Per-currency CIP-implied FCY rate (% p.a.) for the desk's chosen funding
   * regime (rolling = near 1M window, term/stripTerm = spot-to-horizon
   * window) — see `impliedCarryRatePct`. Overrides `inp.r_FCY` in the
   * mean-variance carry direction (μ) ONLY: the single-currency `dir`/`z_opt`
   * scale below stays on the O/N NP rate per decisions.md "H redefined" — H*
   * is an NP holding-cost decision, not a swap-points one. μ is the portfolio
   * TILT direction, which is realised by trading the actual funding swap, so
   * it should reflect what that swap actually costs under the active regime.
   * Missing/absent entries fall back to the flat `inp.r_FCY` unchanged.
   */
  impliedRFcyByCcy?: Record<string, number>,
): PortfolioCarryResult[] {
  const fcyInputs = inputs.filter(inp => inp.ccy !== 'USD');

  // Neutral base = HOLD the book: max(trough,0) + floor + σ cushion for every
  // currency. Existing LP holdings are NOT charged against the P&L budget and
  // are never liquidated by the VAR layer itself.
  //
  // dir = the FULL discretionary carry leg = (carry-only target) − base:
  //   PAY  : carry target = floor + σ + δ           → dir = δ − max(trough,0)
  //   EARN : carry target = max(trough,0)+floor+σ+δ → dir = δ
  // so s = 1 reproduces the carryOptim stack EXACTLY — portfolioDiv is a
  // continuous diversification correction on the carry targets, not a base
  // redefinition. Tight limit → s < 1 (shrink toward hold-the-book); loose
  // limit → s > 1 (amplify carry beyond the per-currency optimum).
  const meta = fcyInputs.map(inp => {
    const p = CURRENCY_PARAMS[inp.ccy];
    const Δr = r_USD - inp.r_FCY;
    const payCarry = isPayCarry(r_USD, inp.r_FCY);
    const trough = inp.forecasted_cash;
    const base = Math.max(trough, 0) + inp.floor_contrib + inp.delta_sigma;
    let dir = 0, z_opt = Z_NEUTRAL;
    let manual = false;
    if (payoutCarry && p) {
      const scale = Math.max(Math.abs(inp.lp_cash), 0.001);
      manual = typeof inp.carry_target === 'number' && Number.isFinite(inp.carry_target);
      if (manual) {
        // A manually stated Target LP Cash IS the overlay leg — the desk decided it,
        // so `s` must not rescale it (see heldAt). It still consumes VAR and USD
        // budget, and enforcePortfolioVarCap can still trim it if the limit breaks.
        const payoutScale = inp.P > 0.001 ? inp.P : 0;
        dir = (inp.carry_target! - payoutScale) - base;
        const leg = dir + (payCarry ? Math.max(trough, 0) : 0);
        z_opt = σ_P > 0 ? Z_NEUTRAL + leg / (scale * σ_P) : Z_NEUTRAL;
      } else {
        const beta = Z_NEUTRAL * p.σ_daily * Math.sqrt(21);
        const cd = carryDeltaAt(scale, Δr, inp.r_OD, σ_P, beta, 0, 0);
        // PAY carry liquidates the held stock too (sell down to the carry target);
        // EARN carry buys on top of the held trough.
        dir = cd.delta - (payCarry ? Math.max(trough, 0) : 0);
        z_opt = cd.z_opt;
      }
    }
    return { inp, p, Δr, base, dir, z_opt, manual };
  });

  /** Manual legs sit at full size; `s` only scales what the optimizer still owns. */
  const legAt = (m: (typeof meta)[number], s: number) => (m.manual ? m.dir : s * m.dir);

  const heldWithLegs = (legs: readonly number[]) => meta.map((m, i) => {
    if (!m.p) return { ccy: m.inp.ccy, cash_threshold: m.base };
    const { cash_threshold } = applyNoNegativeLpFloor(m.base + legs[i], m.inp.r_OD, r_USD);
    // Hard minimum: carry tilt never sells the cushion below the enabled floor.
    return { ccy: m.inp.ccy, cash_threshold: applyHardMinFloor(cash_threshold, m.inp.floor_contrib) };
  });
  const heldAt = (s: number) => heldWithLegs(meta.map(m => legAt(m, s)));
  // Hold the book with EVERY leg off, manual ones included — a manual target is a
  // discretionary position and must be charged against the VAR budget like any
  // other, or `s` over-fills the limit and the cap trims it straight back.
  const baseHeld = heldWithLegs(meta.map(() => 0));

  // Policy VAR is charged on the OVERLAY legs (deviation from hold-the-book) —
  // the P&L fluctuation created by the discretionary carry positions, not by
  // pre-existing holdings. The FULL budget therefore converts into carry.
  const overlayVarAt = (s: number) => computePortfolioVAR(
    heldAt(s).map((h, i) => ({ ccy: h.ccy, cashFCY: h.cash_threshold - baseHeld[i].cash_threshold })),
  ).portfolio_VAR_USD;

  const overlayVarLegs = (legs: readonly number[]) => computePortfolioVAR(
    heldWithLegs(legs).map((h, i) => ({
      ccy: h.ccy, cashFCY: h.cash_threshold - baseHeld[i]!.cash_threshold,
    })),
  ).portfolio_VAR_USD;

  // Overlay USD legs: EARN buys consume USD (+), PAY sells generate USD (−).
  // The book is largely self-funding — only the NET draw hits the USD budget.
  const usdShortfallAt = (s: number) => {
    let earnDemand = 0, payProceeds = 0;
    heldAt(s).forEach((h, i) => {
      const spot = CURRENCY_PARAMS[h.ccy]?.spot ?? 0;
      const leg = (h.cash_threshold - baseHeld[i].cash_threshold) * spot;
      if (leg > 0) earnDemand += leg; else payProceeds += -leg;
    });
    return earnDemand - payProceeds - usdBudget_M;
  };
  const usdShortfallLegs = (legs: readonly number[]) => {
    let earnDemand = 0, payProceeds = 0;
    heldWithLegs(legs).forEach((h, i) => {
      const spot = CURRENCY_PARAMS[h.ccy]?.spot ?? 0;
      const leg = (h.cash_threshold - baseHeld[i]!.cash_threshold) * spot;
      if (leg > 0) earnDemand += leg; else payProceeds += -leg;
    });
    return earnDemand - payProceeds - usdBudget_M;
  };

  let legs: number[] | null = null;
  let varBinding = false;
  let budgetBinding = false;
  const anyDir = meta.some(m => !m.manual && Math.abs(m.dir) > 1e-9);

  if (payoutCarry && anyDir) {
    const ccys = meta.map(m => m.inp.ccy);
    const mu = meta.map((m) => {
      const implied = impliedRFcyByCcy?.[m.inp.ccy];
      const rFcy = typeof implied === 'number' && Number.isFinite(implied) ? implied : m.inp.r_FCY;
      return (rFcy - r_USD) / 100;
    });
    const pinnedUsdM = meta.map((m) => {
      if (!m.manual || !m.p) return 0;
      return m.dir * m.p.spot;
    });
    const alloc = allocateCarryVarUsd({
      ccys,
      mu,
      varCapUsdM: policyVAR_M,
      carryTargetUsdYrM,
      pinnedUsdM,
    });
    if (alloc) {
      const mvLegs = meta.map((m, i) => {
        if (m.manual) return m.dir;
        if (!m.p || m.p.spot < 1e-12) return 0;
        return alloc.wUsdM[i]! / m.p.spot;
      });
      legs = mvLegs;
      varBinding = alloc.varBinding;
      if (overlayVarLegs(mvLegs) > policyVAR_M + 1e-6) {
        let lo = 0, hi = 1;
        for (let i = 0; i < 50; i++) {
          const mid = (lo + hi) / 2;
          const scaled = mvLegs.map((leg, j) => (meta[j]!.manual ? leg : mid * leg));
          if (overlayVarLegs(scaled) > policyVAR_M) hi = mid; else lo = mid;
        }
        legs = mvLegs.map((leg, j) => (meta[j]!.manual ? leg : lo * leg));
        varBinding = true;
      }
    }
  }

  let s = 0;
  if (legs == null && payoutCarry && anyDir) {
    let hi = 1, grew = false;
    for (let k = 0; k < 40; k++) {
      if (overlayVarAt(hi) > policyVAR_M) { grew = true; break; }
      hi *= 2;
    }
    if (!grew) {
      s = hi;
    } else {
      let lo = 0;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (overlayVarAt(mid) > policyVAR_M) hi = mid; else lo = mid;
      }
      s = lo; varBinding = true;
    }
  }

  if (legs != null) {
    if (Number.isFinite(usdBudget_M) && usdShortfallLegs(legs) > 1e-6) {
      budgetBinding = true;
      varBinding = false;
      let lo = 0, hi = 1;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const scaled = legs.map((leg, j) => (meta[j]!.manual ? leg : mid * leg));
        if (usdShortfallLegs(scaled) > 1e-6) hi = mid; else lo = mid;
      }
      legs = legs.map((leg, j) => (meta[j]!.manual ? leg : lo * leg));
    }
  } else if (s > 0 && Number.isFinite(usdBudget_M) && usdShortfallAt(s) > 1e-6) {
    budgetBinding = true;
    varBinding = false;
    let lo = 0, hi = s;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (usdShortfallAt(mid) > 1e-6) hi = mid; else lo = mid;
    }
    s = lo;
  }

  const finalLegs = legs ?? meta.map(m => legAt(m, s));

  // Per-currency share of total portfolio VAR from the FINAL overlay legs —
  // the "why this number" figure. Negative = this leg diversifies the book
  // and reduces total risk rather than consuming budget.
  const componentVarByCcy: Record<string, number> = Object.fromEntries(
    computePortfolioVAR(
      heldWithLegs(finalLegs).map((h, i) => ({
        ccy: h.ccy, cashFCY: h.cash_threshold - baseHeld[i]!.cash_threshold,
      })),
    ).currencies.map(c => [c.ccy, c.component_VAR_USD]),
  );

  return meta.flatMap((m, i) => {
    if (!m.p) return [];
    const overlay = finalLegs[i]!;
    const raw_threshold = m.base + overlay;
    const floored = applyNoNegativeLpFloor(raw_threshold, m.inp.r_OD, r_USD);
    // Trim precedence matches the bisections above: a floor always wins (the
    // leg literally cannot go further), USD budget overrides a VAR trim when
    // both would apply (see `varBinding = false` in the budget bisection),
    // so VAR is only the reason when nothing tighter also bound.
    const binding_reason: PortfolioCarryResult['binding_reason'] = floored.debit_floor_binding
      ? 'floor'
      : budgetBinding ? 'usdBudget'
      : varBinding ? 'varCap'
      : null;
    return [{
      ccy: m.inp.ccy,
      delta_carry: overlay,
      delta_portfolio: overlay,
      base_hold: m.base,
      cash_threshold: applyHardMinFloor(floored.cash_threshold, m.inp.floor_contrib),
      cash_threshold_raw: raw_threshold,
      debit_floor_binding: floored.debit_floor_binding,
      z_opt: m.z_opt,
      lambda: varBinding ? 1 : 0,
      lambda_usd: budgetBinding ? 1 : 0,
      constrained: varBinding || budgetBinding,
      var_binding: varBinding,
      binding_reason,
      component_var_usd: componentVarByCcy[m.inp.ccy] ?? 0,
      manual: m.manual,
      budget_binding: budgetBinding,
      carry_dir: m.Δr > 0.05 ? 'pay' as const : m.Δr < -0.05 ? 'earn' as const : 'neutral' as const,
      delta_r: m.Δr,
    }];
  });
}

// ── Portfolio carry/VAR frontier — simplest case: pure VAR cap ────────────
//
// optimizePortfolioCarry solves for ONE k (bisected to your VAR cap). This
// traces many k instead, so the desk can see the tradeoff curve and where it
// bends — not just the single point the current settings landed on.
//
// Two independent things bend this into a genuine curve — mirroring exactly
// the two mechanisms the per-currency frontier (liquidity-frontier.ts) uses,
// generalized to a correlated multi-currency book:
//
//  1. Floor clamping: legs = k × Σ⁻¹μ is a FIXED direction, so on its own an
//     unclamped ray has carry and VAR both exactly linear in k. The only
//     thing that bends THAT part of the curve is a currency's overlay
//     running into its floor and stopping early while the rest keep
//     growing.
//  2. Fixed standalone exposure (PortfolioCarryInput.delta_cfar): VAR is
//     blended as Z×√(fixedVariance + overlayVariance) — the same
//     √(fixed²+scaling²) shape displayedCfarUsdMFromFxNet uses per currency
//     (cfar-net-by-ccy.ts), just with the fixed terms treated as
//     independent across currencies (no evidence of correlation between
//     different currencies' OWN base exposures) while the overlay portion
//     still correlates via the 14×14 matrix. This alone guarantees real
//     curvature — flat-sloped at k=0, asymptotically linear for large k —
//     with NO floor clamp required at all. If every currency's delta_cfar
//     is 0 (the default), this collapses back to exactly case 1.
//
// Carry gets the matching credit/debit split: a leg is priced at the
// deposit-rate μ while its FINAL position stays in credit, and at the
// (worse) overdraft rate once the overlay pushes it into debit — same
// mechanism as unfundedCashCarryUsdYr's avgCredit/avgDebit split, producing
// a real kink in carry exactly where a currency's position crosses zero.
//
// Conservative is NOT pinned here. Unhedged → hold is a priced standing
// walk (`pricedFundingWalk`); this sweep is overlay-only from Unhedged.
// The pink far/hedged arm is CIP overlay from the same Unhedged fork.
//
// frontierKneeIndex trusts a knee whenever a genuine curvature source is
// present (fixed CFaR always qualifies; a pure floor-clamp ray only
// qualifies at points that actually clamped) — otherwise "furthest from the
// chord" would just be floating-point noise on a genuinely straight line.
//
// Scope: no manual pins, no USD funding budget — those are structurally
// different constraints (a hard ceiling vs. this smooth quadratic one, and a
// leg that never scales with k) and need their own sweep. This is the
// starting case; usdBudget- and manual-pin-aware sweeps are follow-up work.

export interface PortfolioCarryFrontierPoint {
  /** Scale along the fixed Σ⁻¹μ ray — k = 1 is defined as a $1M VAR fill. */
  k: number;
  portfolioVarUsd: number;
  totalCarryUsdYr: number;
  /** Currencies floor-clamped at this point — the source of any curvature here. */
  floorBoundCcys: string[];
  /** Left-end leverage tail — live-book framing ignores these. */
  levered?: boolean;
}

export interface PortfolioCarryFrontier {
  points: PortfolioCarryFrontierPoint[];
  /**
   * Cash carry (same near-leg floor walk) plus real forward-hedge carry
   * priced by the caller's farLegCarryUsdYr — same pink "far" arm the
   * per-currency frontier renders, same fwdHedgeCarryFromMarketUsd pricer.
   * Empty when farLegCarryUsdYr is not supplied.
   */
  farPoints: PortfolioCarryFrontierPoint[];
  /**
   * Index into `points` of the auto-detected knee, or −1 when no ray exists
   * OR no currency floor-clamped anywhere in the swept range (the frontier
   * is a straight line, so there is no genuine sweet spot to report).
   */
  sweetSpotIndex: number;
  /**
   * When `sweetSpotIndex === -1`, the currency and VAR level (solved in
   * closed form, not by re-sweeping) where the FIRST clamp would occur on
   * the unclamped ray, if any currency clamps at all. `null` means no
   * currency in this book ever clamps in either direction — the ray is
   * straight by construction, at any range, not a "range too small" case.
   */
  nearestClampCcy: string | null;
  nearestClampVarUsd: number | null;
  /** `book-scale` = S(t) walk (no Σ⁻¹μ dashed ray). Overlay sweep leaves this unset. */
  walk?: 'book-scale' | 'overlay';
}

export function sweepPortfolioCarryFrontier(
  inputs: PortfolioCarryInput[],
  σ_P: number,
  r_USD: number,
  /** Desk's current policy VAR cap ($M) — the sweep's range is tied to this. */
  policyVAR_M: number,
  steps = 24,
  /** How far past today's cap to trace, in multiples of it. */
  rangeMultiple = 3,
  /**
   * Per-currency CIP-implied FCY rate (% p.a.) for the desk's chosen funding
   * regime — same override optimizePortfolioCarry's μ takes (see there for
   * why). Missing entries fall back to the flat `inp.r_FCY`.
   */
  impliedRFcyByCcy?: Record<string, number>,
  /**
   * Real per-leg forward-hedge carry pricer for the far/hedged arm — the
   * caller supplies this (dashboard-model.ts wires it to
   * fwdHedgeCarryFromMarketUsd against the desk's uploaded market swap
   * points, the SAME function and inputs the per-currency frontier's own
   * far/hedged arm prices with). Called once per currency per swept k with
   * that leg's overlay notional (FCY). The wired pricer is hedge-signed
   * (sell FCY = negative), so the caller passes −legFcy for a long overlay.
   * Missing = farPoints comes back empty (no far arm to show).
   */
  farLegCarryUsdYr?: (ccy: string, legFcy: number) => number,
  /**
   * Rate-differential vol (bp/yr) per currency for the far/hedged arm's VAR
   * — same rateVolBpYrFor desk table the real per-currency funding-swap
   * CFaR uses. Missing = far arm's VAR is fixed-only (no rate-risk term).
   */
  rateVolBpYrByCcy?: Record<string, number>,
  /**
   * Forecast horizon in months (T) — scales both the near (FX-vol) and far
   * (rate-vol) overlay VAR from the fixed 1-month figure computePortfolioVAR
   * / portfolioRateVarUsd compute internally out to the real horizon, √T,
   * same principle the per-currency frontier's standingCfarBandsUsdM uses
   * (farSettleExposureCfarUsdM). Both functions are homogeneous of degree 1
   * in the position vector, so scaling their 1-month output by √T is exact
   * — no need to re-run the calc at T-month vol. Real per-currency vol
   * (CURRENCY_PARAMS.σ_daily / rateVolBpYrFor) throughout, NOT the modal's
   * flat curriculum constant. Default 1 = no change from the original
   * fixed-1-month behavior.
   */
  horizonMonths = 1,
  /**
   * Unhedged portfolio CFaR ($M) from the same book as CFaR-tab Net /
   * Overdraft Sum — `sumNetCfarUsdM(fxOnlyNetByCcyUsdM)` at the live
   * confidence. Pins k=0 to that number. Omit to keep the legacy
   * RSS(delta_cfar×spot) origin.
   */
  unhedgedCfarUsdM?: number,
): PortfolioCarryFrontier {
  const horizonScale = Math.sqrt(Math.max(1, horizonMonths));
  const fcyInputs = inputs.filter(inp => inp.ccy !== 'USD' && CURRENCY_PARAMS[inp.ccy]);
  if (fcyInputs.length === 0 || !(policyVAR_M > 0)) return { points: [], farPoints: [], sweetSpotIndex: -1, nearestClampCcy: null, nearestClampVarUsd: null };

  const ccys = fcyInputs.map(inp => inp.ccy);
  const mu = fcyInputs.map((inp) => {
    const implied = impliedRFcyByCcy?.[inp.ccy];
    const rFcy = typeof implied === 'number' && Number.isFinite(implied) ? implied : inp.r_FCY;
    return (rFcy - r_USD) / 100;
  });
  // Same hold-the-book base optimizePortfolioCarry uses — VAR and carry are
  // both measured on the OVERLAY (deviation from this), never on the base.
  const bases = fcyInputs.map(inp => Math.max(inp.forecasted_cash, 0) + inp.floor_contrib + inp.delta_sigma);

  // Each currency's own standalone FX exposure risk — see the module
  // comment. 0 for every currency (the default when delta_cfar is unset)
  // reproduces the old pure-floor-clamp behavior exactly. delta_cfar is FCY
  // (cfarCoverFcyFor converts the desk's USD Net CFaR to FCY on the way
  // in, per LayeredBufferResult's own "FX-hedge Net CFaR in FCY" — see
  // buildPass1Fcy) — convert back to USD here, or this is off by ~spot per
  // currency: ~10% for EUR, orders of magnitude for JPY/HUF/ZAR where spot
  // is far from 1.
  const fixedVarUsd = fcyInputs.map((inp) => {
    const p = CURRENCY_PARAMS[inp.ccy];
    return Math.abs(inp.delta_cfar ?? 0) * (p?.spot ?? 1);
  });
  const fixedVariance = fixedVarUsd.reduce((s, v) => s + (v / Z_NEUTRAL) ** 2, 0);
  const pinnedUnhedged = typeof unhedgedCfarUsdM === 'number'
    && Number.isFinite(unhedgedCfarUsdM)
    && unhedgedCfarUsdM >= 0
    ? unhedgedCfarUsdM
    : null;
  const pinCfar = pinnedUnhedged;
  const blendVar = (overlayVarUsd: number, originUsd: number | null) => {
    if (originUsd != null) return Math.hypot(originUsd, overlayVarUsd);
    const overlayVariance = (overlayVarUsd / Z_NEUTRAL) ** 2;
    return Z_NEUTRAL * Math.sqrt(overlayVariance + fixedVariance);
  };

  // Fixed direction — the same Σ⁻¹μ ray the live optimizer follows, scaled so
  // k = 1 fills exactly $1M of VAR: a stable, readable unit for the x-axis
  // that does not depend on whatever policyVAR happens to be set to today.
  const alloc = allocateCarryVarUsd({ ccys, mu, varCapUsdM: 1, skipLeverageCap: true });
  if (!alloc) return { points: [], farPoints: [], sweetSpotIndex: -1, nearestClampCcy: null, nearestClampVarUsd: null };
  const unitLegUsd = alloc.wUsdM;

  const evalAt = (k: number) => {
    let totalCarryUsdYr = 0;
    const floorBoundCcys: string[] = [];
    const legsFcy = fcyInputs.map((inp, i) => {
      const p = CURRENCY_PARAMS[inp.ccy]!;
      const overlayFcy = p.spot > 1e-12 ? (k * unitLegUsd[i]!) / p.spot : 0;
      const raw = bases[i]! + overlayFcy;
      const { cash_threshold, debit_floor_binding } = applyNoNegativeLpFloor(raw, inp.r_OD, r_USD);
      const floored = applyHardMinFloor(cash_threshold, inp.floor_contrib);
      if (debit_floor_binding || Math.abs(floored - raw) > 0.001) floorBoundCcys.push(inp.ccy);
      const legFcy = floored - bases[i]!;
      // Credit/debit split — same mechanism as unfundedCashCarryUsdYr: price
      // at the deposit rate μ while the FINAL position is still in credit,
      // at the overdraft rate once the overlay has pushed it into debit.
      const muDebit = (inp.r_OD - r_USD) / 100;
      const rate = floored >= 0 ? mu[i]! : muDebit;
      totalCarryUsdYr += legFcy * p.spot * rate;
      return { ccy: inp.ccy, cashFCY: legFcy };
    });
    // computePortfolioVAR is a fixed 1-month figure — scale to the real
    // forecast horizon (√T, homogeneity — see horizonMonths doc above).
    const overlayVarUsd = computePortfolioVAR(legsFcy).portfolio_VAR_USD * horizonScale;
    // √(fixed² + overlay²) — see the module comment for why this mirrors
    // displayedCfarUsdMFromFxNet's per-currency shape, generalized so the
    // overlay portion keeps its cross-currency correlation.
    return { portfolioVarUsd: blendVar(overlayVarUsd, pinCfar), totalCarryUsdYr, floorBoundCcys };
  };

  // Far/hedged arm: same near-leg cash position/floor walk as evalAt (a
  // forward overlay is a separate derivative — it does not touch the cash
  // ladder). Carry = cash carry (same as near) plus the real forward-hedge
  // carry from the caller's farLegCarryUsdYr (fwdHedgeCarryFromMarketUsd
  // against the desk's actual uploaded swap points, not a flat CIP rate).
  // VAR is NOT the near arm's FX-vol VAR — a forward hedge means CIP
  // near+far cancels spot, so FX spot risk is gone; the only residual risk
  // is the rate-differential vol on the outstanding notional (same driver
  // fundingSwapBridgeBands/rateVolBpYrFor use for the real per-currency
  // model's funding-swap CFaR). portfolioRateVarUsd prices that.
  const evalFarAt = (k: number) => {
    let totalCarryUsdYr = 0;
    const legs = fcyInputs.map((inp, i) => {
      const p = CURRENCY_PARAMS[inp.ccy]!;
      const overlayFcy = p.spot > 1e-12 ? (k * unitLegUsd[i]!) / p.spot : 0;
      const raw = bases[i]! + overlayFcy;
      const { cash_threshold } = applyNoNegativeLpFloor(raw, inp.r_OD, r_USD);
      const floored = applyHardMinFloor(cash_threshold, inp.floor_contrib);
      const legFcy = floored - bases[i]!;
      const muDebit = (inp.r_OD - r_USD) / 100;
      const rate = floored >= 0 ? mu[i]! : muDebit;
      totalCarryUsdYr += legFcy * p.spot * rate;
      if (farLegCarryUsdYr) totalCarryUsdYr += farLegCarryUsdYr(inp.ccy, legFcy);
      return { ccy: inp.ccy, legFcy, spot: p.spot };
    });
    // Same fixed-1-month → real-horizon √T scaling as the near arm.
    const overlayVarUsd = rateVolBpYrByCcy
      ? portfolioRateVarUsd(legs, rateVolBpYrByCcy) * horizonScale
      : 0;
    // Far tail is CIP / fully-hedged overlay from Unhedged — not the
    // funded H* hold. Conservative cash+swap is open-arm only.
    return { portfolioVarUsd: blendVar(overlayVarUsd, pinnedUnhedged), totalCarryUsdYr };
  };

  // Range tied to today's policy VAR, not a self-terminating search: an EARN
  // currency's overlay has NO upper floor in this scope (no USD budget yet —
  // see the module comment), so "sweep until every currency floor-clamps"
  // can never terminate the moment any currency is EARN-direction. Tracing
  // out to a fixed multiple of the desk's actual cap is bounded by
  // construction and answers the question the desk actually has: "if I moved
  // my limit, would I still be on the straight part of the line, or past the
  // bend already?"
  const kMax = policyVAR_M * Math.max(1, rangeMultiple);

  // Closed-form first clamp — independent of the sampled grid. Only a SOLD
  // leg (w < 0) with a real threshold clamps; EARN has no upper floor here.
  let nearestClampCcy: string | null = null;
  let nearestClampVarUsd: number | null = null;
  fcyInputs.forEach((inp, i) => {
    const w = unitLegUsd[i]!;
    if (w >= 0) return;
    const p = CURRENCY_PARAMS[inp.ccy]!;
    const threshold = inp.floor_contrib > 0.001
      ? inp.floor_contrib
      : (allowsNegativeLp(inp.r_OD, r_USD) ? null : 0);
    if (threshold == null) return;
    const gapFcy = bases[i]! - threshold;
    if (gapFcy <= 0) return;
    const breakVarUsd = (gapFcy * p.spot) / -w;
    if (!Number.isFinite(breakVarUsd) || breakVarUsd <= 0) return;
    if (nearestClampVarUsd == null || breakVarUsd < nearestClampVarUsd) {
      nearestClampVarUsd = breakVarUsd;
      nearestClampCcy = inp.ccy;
    }
  });

  const ks = new Set<number>();
  for (let s = 0; s <= steps; s++) ks.add((kMax * s) / steps);
  if (nearestClampVarUsd != null && nearestClampVarUsd < kMax) {
    ks.add(nearestClampVarUsd);
    ks.add(Math.max(0, nearestClampVarUsd * 0.82));
    ks.add(Math.min(kMax, nearestClampVarUsd * 1.18));
  }
  // Denser sampling near k=0 — the fixed-CFaR RSS shape (√(fixed²+overlay²))
  // bends hardest right at the origin (see the module comment: flat slope
  // at k=0, curving as the overlay term catches up to the fixed one) and
  // flattens out toward a straight ray further along. The linear grid above
  // can step clean over that whole bend in one stride when kMax is large,
  // rendering a genuinely curved region as a straight segment. Geometric
  // spacing (i/nearSteps)² biases points toward k=0 within the first 8% of
  // the range, without touching the existing linear/clamp grid.
  if (kMax > 0) {
    const nearFrac = 0.08;
    const nearSteps = 12;
    for (let i = 1; i <= nearSteps; i++) {
      ks.add(kMax * nearFrac * (i / nearSteps) ** 2);
    }
  }

  const overlayPoints: PortfolioCarryFrontierPoint[] = [...ks]
    .sort((a, b) => a - b)
    .map(k => {
      const { portfolioVarUsd, totalCarryUsdYr, floorBoundCcys } = evalAt(k);
      return {
        k,
        portfolioVarUsd,
        totalCarryUsdYr,
        floorBoundCcys,
      };
    });

  const points = overlayPoints;

  const farSweep: PortfolioCarryFrontierPoint[] = farLegCarryUsdYr
    ? [...ks].sort((a, b) => a - b).map((k) => {
        const { portfolioVarUsd, totalCarryUsdYr } = evalFarAt(k);
        return {
          k,
          portfolioVarUsd,
          totalCarryUsdYr,
          floorBoundCcys: [],
        };
      })
    : [];
  // Shared Unhedged fork: no H* buffer, no overlay, no CIP. Green and pink
  // are priced independently after this point (open/buffer vs far hedge).
  const unhedgedOrigin: PortfolioCarryFrontierPoint | null = pinnedUnhedged != null
    ? {
      k: -1,
      portfolioVarUsd: pinnedUnhedged,
      totalCarryUsdYr: 0,
      floorBoundCcys: [],
    }
    : null;
  const isUnhedgedOrigin = (p: PortfolioCarryFrontierPoint) => (
    unhedgedOrigin != null
    && Math.abs(p.portfolioVarUsd - unhedgedOrigin.portfolioVarUsd) < 1e-6
    && Math.abs(p.totalCarryUsdYr) < 1e-6
  );
  const openArmed = unhedgedOrigin && (points.length === 0 || !isUnhedgedOrigin(points[0]!))
    ? [unhedgedOrigin, ...points]
    : points;
  const farPoints = farLegCarryUsdYr
    ? (unhedgedOrigin
      ? [unhedgedOrigin, ...farSweep.filter(p => p.k > 1e-12)]
      : farSweep)
    : [];

  const overlayKnee = frontierKneeIndex(overlayPoints, fixedVariance > 1e-9 || pinCfar != null);
  const fundingPad = openArmed.length - overlayPoints.length;
  return {
    points: openArmed,
    farPoints,
    sweetSpotIndex: overlayKnee >= 0 ? overlayKnee + fundingPad : -1,
    nearestClampCcy,
    nearestClampVarUsd,
  };
}

/**
 * Point farthest from the straight line joining the frontier's two ends —
 * the bend. Without a fixed CFaR term, on the unclamped stretch every point
 * sits ON that chord (the ray is linear), so this correctly returns 0
 * distance until floor-clamping actually bends the curve away from it. With
 * a fixed CFaR term, √(fixed²+overlay²) is never exactly linear, so every
 * point is a legitimate candidate — see the module comment.
 */
function frontierKneeIndex(
  points: readonly PortfolioCarryFrontierPoint[],
  hasFixedCfar: boolean,
): number {
  if (points.length < 3) return Math.max(0, points.length - 1);
  const p0 = points[0]!;
  const pN = points[points.length - 1]!;
  const dx = pN.portfolioVarUsd - p0.portfolioVarUsd;
  const dy = pN.totalCarryUsdYr - p0.totalCarryUsdYr;
  const norm = Math.hypot(dx, dy);
  if (norm < 1e-9) return -1;
  let bestIdx = -1;
  let bestDist = -Infinity;
  points.forEach((p, i) => {
    // Without a fixed CFaR term, only a genuine floor clamp bends the fixed
    // Σ⁻¹μ ray (see the module comment above sweepPortfolioCarryFrontier) —
    // without one, every point sits on (or numerically near) the straight
    // chord, so "furthest from the chord" would just be floating-point
    // noise, not a real knee. That noise is what made the "use $X.XM"
    // button walk to a different, larger value on every click instead of
    // settling on a stable optimum. A fixed CFaR term removes that
    // ambiguity entirely — curvature is then structurally guaranteed.
    if (!hasFixedCfar && p.floorBoundCcys.length === 0) return;
    const cross = (p.portfolioVarUsd - p0.portfolioVarUsd) * dy - (p.totalCarryUsdYr - p0.totalCarryUsdYr) * dx;
    const dist = Math.abs(cross) / norm;
    if (dist > bestDist) { bestDist = dist; bestIdx = i; }
  });
  return bestIdx;
}

// ── Portfolio USD VAR — multi-currency diversified buffer ─────────────────
//
// Computes portfolio-level 1-month VAR across all FCY buffer holdings using
// pairwise correlations.  Low-correlation currencies (e.g. JPY vs EM) provide
// genuine diversification — portfolio VAR < sum of standalone VARs.
//
// Policy VAR thresholds (from fx-hedging-policy.md, 95% confidence):
//   >  $5M → Director of Finance approval
//   > $10M → CFO approval
//   > $20M → CEO approval

/** Canonical display list — used in all three tabs for consistent currency coverage */
export const DISPLAY_CURRENCIES: string[] = [
  'EUR','GBP','AUD','JPY','CHF','CAD','MXN','TRY','ZAR','PLN','NOK','SEK','HUF','ILS','AED','USD',
];

/** CCY order matching CORR_MATRIX rows and columns */
export const CORR_CURRENCIES: string[] = [
  'EUR','GBP','AUD','JPY','CHF','CAD','MXN','TRY','ZAR','PLN','NOK','SEK','HUF','ILS',
];

/**
 * 14×14 pairwise correlation matrix (historical daily log-return correlations, USD base).
 * Row/col order: EUR GBP AUD JPY CHF CAD MXN TRY ZAR PLN NOK SEK HUF ILS
 * Source: approximate empirical values (2019–2026); recalibrate on regime change.
 */
export const CORR_MATRIX: number[][] = [
  //EUR    GBP    AUD    JPY    CHF    CAD    MXN    TRY    ZAR    PLN    NOK    SEK    HUF    ILS
  [ 1.00,  0.77,  0.52, -0.15,  0.68,  0.43,  0.38,  0.18,  0.42,  0.74,  0.72,  0.83,  0.72,  0.25], // EUR
  [ 0.77,  1.00,  0.48, -0.12,  0.58,  0.40,  0.35,  0.16,  0.38,  0.63,  0.62,  0.70,  0.62,  0.24], // GBP
  [ 0.52,  0.48,  1.00, -0.05,  0.43,  0.58,  0.48,  0.20,  0.50,  0.43,  0.52,  0.47,  0.42,  0.18], // AUD
  [-0.15, -0.12, -0.05,  1.00,  0.42, -0.20, -0.28, -0.25, -0.22, -0.18, -0.12, -0.18, -0.18,  0.05], // JPY
  [ 0.68,  0.58,  0.43,  0.42,  1.00,  0.38,  0.33,  0.12,  0.38,  0.58,  0.55,  0.62,  0.58,  0.20], // CHF
  [ 0.43,  0.40,  0.58, -0.20,  0.38,  1.00,  0.52,  0.18,  0.45,  0.40,  0.55,  0.45,  0.38,  0.15], // CAD
  [ 0.38,  0.35,  0.48, -0.28,  0.33,  0.52,  1.00,  0.22,  0.55,  0.38,  0.45,  0.40,  0.38,  0.20], // MXN
  [ 0.18,  0.16,  0.20, -0.25,  0.12,  0.18,  0.22,  1.00,  0.25,  0.28,  0.18,  0.22,  0.32,  0.18], // TRY
  [ 0.42,  0.38,  0.50, -0.22,  0.38,  0.45,  0.55,  0.25,  1.00,  0.42,  0.48,  0.43,  0.38,  0.22], // ZAR
  [ 0.74,  0.63,  0.43, -0.18,  0.58,  0.40,  0.38,  0.28,  0.42,  1.00,  0.65,  0.70,  0.72,  0.28], // PLN
  [ 0.72,  0.62,  0.52, -0.12,  0.55,  0.55,  0.45,  0.18,  0.48,  0.65,  1.00,  0.82,  0.62,  0.25], // NOK
  [ 0.83,  0.70,  0.47, -0.18,  0.62,  0.45,  0.40,  0.22,  0.43,  0.70,  0.82,  1.00,  0.68,  0.25], // SEK
  [ 0.72,  0.62,  0.42, -0.18,  0.58,  0.38,  0.38,  0.32,  0.38,  0.72,  0.62,  0.68,  1.00,  0.28], // HUF
  [ 0.25,  0.24,  0.18,  0.05,  0.20,  0.15,  0.20,  0.18,  0.22,  0.28,  0.25,  0.25,  0.28,  1.00], // ILS
];

export interface PortfolioVARInput {
  ccy: string;
  cashFCY: number;  // M FCY (buffer holding)
}

export interface PortfolioVARCcyResult {
  ccy: string;
  cashFCY: number;
  cashUSD: number;             // M USD = cashFCY × spot
  vol1M_USD: number;           // 1-month vol = cashUSD × σ_daily × √21 (M USD)
  standalone_VAR_USD: number;  // z₉₅ × vol1M_USD (M USD)
  component_VAR_USD: number;   // marginal contribution to portfolio VAR (M USD)
  beta: number;                // component_VAR / standalone_VAR (0-1; lower = more diversified)
}

export interface PortfolioVARResult {
  portfolio_VAR_USD: number;   // M USD — 1-month 95% portfolio VAR
  standalone_sum_USD: number;  // M USD — sum of individual standalone VARs (no diversification)
  div_benefit_USD: number;     // M USD — diversification saving = standalone − portfolio
  div_factor: number;          // portfolio_VAR / standalone_sum (0-1; lower = more benefit)
  total_cash_USD: number;      // M USD — total FCY buffer holdings
  currencies: PortfolioVARCcyResult[];
}

/**
 * Compute diversified portfolio VAR across FCY buffer holdings.
 * Only currencies present in CORR_CURRENCIES are included.
 *
 * portfolio_VAR = z₉₅ × √(Σᵢ Σⱼ vol_i × vol_j × ρᵢⱼ)
 * component_VAR_i = z₉₅ × vol_i × (Σⱼ ρᵢⱼ × vol_j) / portfolio_vol
 */
// ── Simulation row state ──────────────────────────────────────────────────
//
// Shared across all three tabs so FX book edits in the Simulator
// immediately flow into Layer Analysis and vice versa.

/** Per-currency editable row in the FX Simulator table */
/** Per-currency computed results from LayeredBufferAnalysis — synced back to FX Simulator. */
export interface LayerResult {
  ccy: string;
  cash_threshold: number; // Cash Threshold with all active layers (incl. portfolio VAR)
  swap_needed: number;    // Swap Near Leg sized against cash_threshold
  carry_dir: 'earn' | 'pay' | 'neutral';
  delta_r: number;        // r_USD − r_FCY
}

export interface RowState {
  id: string;
  ccy: string;
  σ_daily: number;
  r_FCY: number;   // FCY deposit / LP credit rate % p.a.
  r_OD: number;    // FCY overdraft / LP debit rate % p.a.
  β_IR: number;
  spot: number;    // TMS FX spot exposure (M FCY, neg = short)
  fwd: number;     // Outstanding cash settlement (M USD from TMS)
  nonCash: number; // Non-cash BS FX (liability side — enter negative for payables)
  /** Non-cash ASSET FX exposure (M FCY): accruals/receivables/NDF assets — adds to net FX exposure. Optional; defaults 0. */
  nonCashAsset?: number;
  cash: number;    // Cash balance (M FCY)
  payout: number;  // 1-month payout forecast (M FCY, neg = outflow)
  collections: number;   // FCY inflows arriving AFTER payouts (positive); trough = cash+payout, month-end = cash+payout+collections
  fcastFX: number;       // Forecasted invoice FX for this payment cycle (M FCY); drives hedge size; 0 = no forecast entered
  nonLpCash: number;     // FCY held outside LP: Model 2/3; affects Net Delta only, not LP swap sizing
  cash_floor: number;   // Per-currency minimum cash threshold (M FCY), default 0
  /**
   * Manual Target LP Cash (M FCY) for the carry layer — set from the carry desk by
   * typing either a cash target or a carry P&L target. Undefined = size the carry
   * leg from z_opt = Φ⁻¹(1 − Δr/r_OD) as usual. Floors and the VAR cap still bind.
   */
  carry_target?: number;
  // ── IR Profile (Interest Rate Asset/Liability) ────────────────────────────
  ir_asset_notional: number; // Fixed-rate FCY assets: deposits, bonds, receivables (M FCY)
  ir_asset_rate: number;     // Fixed asset coupon / deposit rate (% p.a.)
  ir_liab_notional: number;  // Fixed-rate FCY liabilities: borrowings, LP overdraft (M FCY)
  ir_liab_rate: number;      // Fixed liability funding cost (% p.a.)
  ir_net_dur: number;        // Net modified duration of fixed-rate book (years); 0 = floating/no fixed book
  ir_invest_notional?: number; // Interest-earning investment positions (M FCY); optional
  ir_invest_rate?: number;     // Investment yield (% p.a.); optional
}

/** USD row parameters in the FX Simulator */
export interface UsdParams {
  σ_daily: number;
  r_FCY: number;
  r_OD: number;
  β_IR: number;
  payout: number;
  /** Gross payins / expected inflows arriving after payouts (M USD, enter positive). */
  collections: number;
  ir_asset_notional: number;
  ir_asset_rate: number;
  ir_liab_notional: number;
  ir_liab_rate: number;
  ir_net_dur: number;
  ir_invest_notional?: number;
  ir_invest_rate?: number;
}

export function makeSimRow(
  id: string, ccy: string,
  spot: number, fwd: number, nonCash: number, cash: number, payout: number,
  collections = 0, nonLpCash = 0, fcastFX = 0,
  ir_asset_notional = 0, ir_asset_rate = 0,
  ir_liab_notional = 0, ir_liab_rate = 0, ir_net_dur = 0
): RowState {
  const p = CURRENCY_PARAMS[ccy];
  return {
    id, ccy,
    σ_daily: p?.σ_daily ?? 0.005,
    r_FCY:   p?.carry   ?? 3.0,
    r_OD:    p?.r_OD    ?? 7.0,
    β_IR:    p?.β_IR    ?? 0.25,
    spot, fwd, nonCash, cash, payout, collections, fcastFX, nonLpCash,
    cash_floor: 0,
    ir_asset_notional, ir_asset_rate, ir_liab_notional, ir_liab_rate, ir_net_dur,
  };
}

// Data sourced from: FX Exposure Check Up.xlsx (sheet "Notional Pool FX Exposure Check" + "Notional Pool Blance + Local")
// spot    = TMS FX Exposure ÷ 1e6            (net FX book position, M FCY — from sheet1)
// fwd     = Outstanding Cash Settlement ÷ 1e6 (M USD from sheet1; FCY via usdToFcyM)
// nonCash = simulated ±1–3% of exposure       (accruals / NDFs; real data pending)
// cash    = NP Total (NP Citi + NP JPM) ÷ 1e6 (FCY M — from sheet2 "Notional Pool Blance + Local")
// nonLpCash = Local Books ÷ 1e6              (FCY M — from sheet2 "Notional Pool Blance + Local")
// payout, collections: set to 0 — fill from TMS forecast
export const INITIAL_ROWS: RowState[] = [
  //           id   ccy    spot(FCY)  fwd(USD)  nonCash   cash=NP Total  payout  coll  nonLpCash=Local
  makeSimRow('1',  'CAD',   320.2,    -9.1,      1.2,     95.1,          0, 0,   34.1),
  makeSimRow('2',  'AED',   185.9,   -33.0,     -0.6,    -26.9,          0, 0,   40.4),
  makeSimRow('3',  'ILS',   105.2,     0.3,      0.5,     -4.7,          0, 0,    4.1),
  makeSimRow('4',  'GBP',   175.6,     4.4,     -0.4,    131.8,          0, 0,   27.5),
  makeSimRow('5',  'JPY',  1827.7,  -135.3,     15.0,   -869.1,          0, 0, 1356.8),
  makeSimRow('6',  'SGD',    40.8,    -0.8,      0.2,      4.2,          0, 0,   16.2),
  makeSimRow('7',  'TRY',   389.0,    18.3,      1.5,     97.3,          0, 0,    5.0),
  makeSimRow('8',  'SEK',   149.8,    -3.4,      0.6,     45.8,          0, 0,   77.5),
  makeSimRow('9',  'THB',   291.3,     3.4,      1.0,    154.9,          0, 0,   37.9),
  makeSimRow('10', 'RON',    37.3,     1.1,     -0.2,     26.5,          0, 0,    0.2),
  makeSimRow('11', 'CZK',   113.8,   -29.2,      0.8,    105.1,          0, 0,    4.0),
  makeSimRow('12', 'HUF',  1159.8,  -204.0,     -8.0,    890.0,          0, 0,   68.4),
  makeSimRow('13', 'RSD',   363.5,     6.4,     -1.5,    362.1,          0, 0,    9.1),
  makeSimRow('14', 'NOK',    44.1,     0.3,      0.4,     47.4,          0, 0,    2.6),
  makeSimRow('15', 'EUR',   146.9,  -120.1,      0.8,    191.7,          0, 0,   81.6),
  makeSimRow('16', 'PLN',    32.8,    -2.6,      0.3,     42.3,          0, 0,    6.0),
  makeSimRow('17', 'DKK',    11.1,    -3.1,      0.1,     46.2,          0, 0,    0.7),
  makeSimRow('18', 'NZD',     5.2,     0.4,      0.1,      4.4,          0, 0,   14.6),
  makeSimRow('19', 'ZAR',    23.4,     6.4,     -0.8,    139.1,          0, 0,   78.9),
  makeSimRow('20', 'HKD',    30.3,    12.6,      0.3,     50.9,          0, 0,   59.7),
  makeSimRow('21', 'AUD',    27.1,    10.2,      0.2,     28.3,          0, 0,   16.0),
  makeSimRow('22', 'CHF',    17.5,    -0.6,     -0.2,     29.8,          0, 0,    0.6),
  makeSimRow('23', 'MXN',  -527.1,   -25.4,     -2.5,    238.0,          0, 0,   20.9),
  makeSimRow('24', 'CNY',    -7.0,   357.5,      0.4,     70.5,          0, 0,   13.4),
];

export const INITIAL_USD_PARAMS: UsdParams = {
  σ_daily: 0,
  r_FCY:   3.50,
  r_OD:    3.89,
  β_IR:    0,
  payout:  0,
  collections: 0,
  ir_asset_notional: 0,
  ir_asset_rate:     0,
  ir_liab_notional:  0,
  ir_liab_rate:      0,
  ir_net_dur:        0,
};

export function computePortfolioVAR(inputs: PortfolioVARInput[]): PortfolioVARResult {
  const valid = inputs.filter(inp => {
    const p = CURRENCY_PARAMS[inp.ccy];
    return p && Math.abs(inp.cashFCY) > 0 && CORR_CURRENCIES.indexOf(inp.ccy) >= 0;
  });

  if (valid.length === 0) {
    return {
      portfolio_VAR_USD: 0, standalone_sum_USD: 0,
      div_benefit_USD: 0, div_factor: 1, total_cash_USD: 0, currencies: [],
    };
  }

  const idx = valid.map(inp => CORR_CURRENCIES.indexOf(inp.ccy));

  // 1-month vol in M USD for each currency
  const vols = valid.map((inp, i) => {
    const p = CURRENCY_PARAMS[inp.ccy]!;
    return inp.cashFCY * p.spot * p.σ_daily * Math.sqrt(21);
  });

  // Portfolio variance = Σᵢ Σⱼ vol_i × vol_j × ρᵢⱼ
  let variance = 0;
  for (let i = 0; i < valid.length; i++) {
    for (let j = 0; j < valid.length; j++) {
      variance += vols[i] * vols[j] * CORR_MATRIX[idx[i]][idx[j]];
    }
  }
  const portfolio_vol = Math.sqrt(Math.max(0, variance));
  const portfolio_VAR_USD = Z_NEUTRAL * portfolio_vol;

  const standalone_VARs = vols.map(v => Z_NEUTRAL * Math.abs(v));
  const standalone_sum_USD = standalone_VARs.reduce((a, b) => a + b, 0);

  // Component VAR_i = z₉₅ × vol_i × (Σⱼ ρᵢⱼ × vol_j) / portfolio_vol
  const component_VARs = valid.map((_, i) => {
    const cov_row = vols.reduce((sum, vj, j) => sum + CORR_MATRIX[idx[i]][idx[j]] * vj, 0);
    return portfolio_vol > 0 ? Z_NEUTRAL * cov_row * vols[i] / portfolio_vol : 0;
  });

  const total_cash_USD = valid.reduce((sum, inp) => {
    return sum + inp.cashFCY * CURRENCY_PARAMS[inp.ccy]!.spot;
  }, 0);

  return {
    portfolio_VAR_USD,
    standalone_sum_USD,
    div_benefit_USD: standalone_sum_USD - portfolio_VAR_USD,
    div_factor: standalone_sum_USD > 0 ? portfolio_VAR_USD / standalone_sum_USD : 1,
    total_cash_USD,
    currencies: valid.map((inp, i) => ({
      ccy: inp.ccy,
      cashFCY: inp.cashFCY,
      cashUSD: inp.cashFCY * CURRENCY_PARAMS[inp.ccy]!.spot,
      vol1M_USD: vols[i],
      standalone_VAR_USD: standalone_VARs[i],
      component_VAR_USD: component_VARs[i],
      beta: standalone_VARs[i] > 0 ? component_VARs[i] / standalone_VARs[i] : 0,
    })),
  };
}

/**
 * Portfolio VAR on a hedged leg, priced off rate-differential vol instead of
 * FX spot vol. A forward-hedged position has CIP near+far cancelling spot —
 * same reasoning fundingSwapBridgeBands/rateVolBpYrFor use for the real
 * per-currency model's funding-swap CFaR: the only residual risk left is
 * uncertainty in the rate differential on the outstanding notional, not FX
 * spot moves. Same cross-currency correlation structure as
 * computePortfolioVAR, different vol source — duplicated rather than shared
 * with it to avoid touching that function's tested behavior.
 */
function portfolioRateVarUsd(
  legs: readonly { ccy: string; legFcy: number; spot: number }[],
  rateVolBpYrByCcy: Record<string, number>,
): number {
  const valid = legs.filter(l => Math.abs(l.legFcy) > 0 && CORR_CURRENCIES.indexOf(l.ccy) >= 0);
  if (valid.length === 0) return 0;
  const idx = valid.map(l => CORR_CURRENCIES.indexOf(l.ccy));
  const vols = valid.map((l) => {
    const bpYr = rateVolBpYrByCcy[l.ccy] ?? 0;
    const sigmaMonthly = bpYr / 10000 / Math.sqrt(12);
    return l.legFcy * l.spot * sigmaMonthly;
  });
  let variance = 0;
  for (let i = 0; i < valid.length; i++) {
    for (let j = 0; j < valid.length; j++) {
      variance += vols[i]! * vols[j]! * CORR_MATRIX[idx[i]!]![idx[j]!]!;
    }
  }
  return Z_NEUTRAL * Math.sqrt(Math.max(0, variance));
}
