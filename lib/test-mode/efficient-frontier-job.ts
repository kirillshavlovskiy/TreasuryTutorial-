/**
 * Server-side efficient-frontier package.
 *
 * The Liquidity tab is a client island (sliders, selection, staging). The
 * engines that build the Σ⁻¹μ overlay, the book-scale arm, and the lifted
 * Total-Carry curve run here so the calc walk prints in the Next.js terminal
 * (`npm run dev`) instead of the browser console.
 */

import {
  computePortfolioCarryFrontier,
  impliedPortfolioRFcyPct,
} from '@/lib/dashboard-model';
import {
  CURRENCY_PARAMS,
  POLICY_VAR_LIMITS,
  bufferLevelOf,
  ccySpotRate,
  fundingSwapCashDeltaUsdYr,
  type LayerId,
  type PortfolioCarryFrontier,
  type RowState,
  type SharedGlobals,
} from '@/lib/fx-buffer';
import type { LiquidityBookingMode } from '@/lib/liquidity-ladder';
import {
  OVERLAY_MATERIALITY_MU,
  OVERLAY_MAX_BASE_MULTIPLE,
  OVERLAY_MAX_LEG_LEVERAGE,
  buildEfficientCarryVarFrontier,
  overlayBookBaseFcyM,
  scaleOverlayLegs,
  type EfficientCarryLeg,
  type EfficientCarryVarFrontier,
} from '@/lib/portfolio-alloc';
import {
  evaluateLiquidityStrategies,
  type LiquidityStrategyId,
  type LiquidityStrategyInput,
  type LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';
import {
  chartPathTrace,
  frontierMonotoneStats,
  pickConservativeFundingBook,
  pricedBalancedVertex,
} from '@/lib/test-mode/portfolio-modal-align';
import {
  buildPortfolioLiquidityFrontier,
  priceBooksAtScale,
  priceRegimeChartCfar,
  toPortfolioCarryFrontier,
  type PortfolioFrontierEngine,
} from '@/lib/test-mode/portfolio-liquidity-frontier';
import {
  liftFrontierToTotalCarry,
  isAskFillMode,
  overlayPortfolioVarUsdM,
  overlayRayFrontier,
  overlayTForPoint,
  overlayTToHitCarry,
  parseAskFillMode,
  pointForScenario,
  resolveAskFillLiftT,
  resolveFrontierScenarioId,
  splitTicketCfarByCcy,
  stripDisplayedCarryUsdM,
  type AskFillMode,
  type SolutionScenarioId,
} from '@/lib/test-mode/solution-pick';

import {
  frontierPointCoords,
  logFrontierChart,
} from '@/lib/test-mode/frontier-chart-debug';

const TAG = '[efficient-frontier]';

const LAYER_IDS: readonly LayerId[] = [
  'sigmaP', 'carryOptim', 'floorH', 'portfolioDiv', 'cfarCover',
];
const STRATEGY_IDS: readonly LiquidityStrategyId[] = [
  'unfunded', 'nearCycle', 'rollingProgramme', 'termSwap', 'stripToTerm',
];
const SCENARIO_IDS: readonly SolutionScenarioId[] = [
  'unhedged', 'carryTarget', 'balanced', 'maxCarry', 'maxReturn', 'custom',
];
const BOOKING_MODES: readonly LiquidityBookingMode[] = [
  'rolling', 'term', 'stripTerm',
];

export const EFFICIENT_FRONTIER_LIMITS = {
  maxRows: 24,
  maxCcys: 24,
  maxMonths: 120,
} as const;

export interface SerializedLiquidityStrategyInput {
  rows: readonly RowState[];
  forecastProfile?: LiquidityStrategyInput['forecastProfile'];
  months: number;
  shared: SharedGlobals;
  activeLayers: readonly LayerId[];
  hedgeSettleByCcy?: LiquidityStrategyInput['hedgeSettleByCcy'];
  livePlanByCcy?: LiquidityStrategyInput['livePlanByCcy'];
  cfarNetByCcyUsd?: LiquidityStrategyInput['cfarNetByCcyUsd'];
  setup?: LiquidityStrategyInput['setup'];
  bookedHedges?: LiquidityStrategyInput['bookedHedges'];
  preparedByCcy?: LiquidityStrategyInput['preparedByCcy'];
  marketRatesByCcy?: LiquidityStrategyInput['marketRatesByCcy'];
  ratesScopeId?: string;
  swapForwardOverlayByCcy?: LiquidityStrategyInput['swapForwardOverlayByCcy'];
  deskHedgeCarryByCcyUsdM?: LiquidityStrategyInput['deskHedgeCarryByCcyUsdM'];
  deskCashCarryByCcyUsdM?: LiquidityStrategyInput['deskCashCarryByCcyUsdM'];
  deskCipByCcyUsdM?: LiquidityStrategyInput['deskCipByCcyUsdM'];
}

export interface EfficientFrontierRequest {
  strategyInput: SerializedLiquidityStrategyInput;
  selectedStrategyId: LiquidityStrategyId;
  policyVAR: number;
  includedCcys: readonly string[] | null;
  tabNetByCcyUsd: Record<string, number>;
  carryTargetUsdYr: number;
  scenarioCapUsd: number;
  bookingMode: LiquidityBookingMode;
  forecastMonths: number;
  confidencePct: number;
  /** How Carry Target fills Target Carry. Default overlay. */
  askFillMode?: AskFillMode;
  scenarioId?: SolutionScenarioId | null;
  customK?: number | null;
  /** Live selected-regime point — same X/Y the strip already printed. */
  selectedPoint?: { totalCarryUsdYr: number; portfolioVarUsd: number } | null;
}

export interface RegimeSolutionUsd {
  totalCarryUsdYr: number;
  portUsdM: number;
}

export interface RegimeChartCfarUsd {
  sumUsdM: number;
  portUsdM: number;
}

export interface EfficientFrontierResult {
  results: LiquidityStrategyResult[];
  mvFrontier: EfficientCarryVarFrontier | null;
  universeFrontier: PortfolioCarryFrontier | null;
  solutionFrontier: PortfolioCarryFrontier | null;
  tabAllCcyNetUsdM: number;
  regimeSolutions: Record<string, RegimeSolutionUsd>;
  regimeChartCfar: Record<string, RegimeChartCfarUsd>;
  /** Server book(k) + overlay(t) split — same numbers as the terminal walk. */
  carryBreakdown: SolutionCarryBreakdown | null;
  /**
   * Per named portfolio scenario — same pricer as `carryBreakdown`.
   * The CCY modal chips read this, not a local book-walk H*.
   */
  scenarioBreakdowns: Record<string, SolutionCarryBreakdown>;
}

/** One CCY of the solution that fulfills the selected point. */
export interface SolutionCarryLeg {
  ccy: string;
  /** Book carry at selected k — same program Y the chart lift uses before overlay. */
  bookUsdYrM: number;
  overlayUsdYrM: number;
  /** Book(k) + Overlay(t). Σ equals the selected chart Y. */
  totalUsdYrM: number;
  overlayUsdM: number;
  overlayFcyM: number;
  mixWeight: number;
  /** k × peak standing. Not Swap Near. */
  bookStandingFcyM: number;
  bookStandingUsdM: number;
  /** Signed cash Δr on Book S — audit only, not Buffer Carry. */
  bookSignedCashUsdYrM: number;
  /** Funding-book CFaR at k. Not overlay FX VAR. */
  bookCfarUsdM: number;
  /** Overlay Euler share of the mix VAR. */
  overlayCfarUsdM: number;
  /** Euler share of ticket CFaR √(Book²+Overlay²). Σ equals totalCfarSum. */
  totalCfarUsdM: number;
}

export interface SolutionCarryBreakdown {
  scenarioId: string;
  k: number;
  overlayT: number;
  askFillMode: AskFillMode;
  /** Selected chart Y — Target Carry intersection when that ask is on the arm. */
  chartY: number;
  askY: number;
  bookSum: number;
  overlaySum: number;
  totalSum: number;
  /** Funding-book Port CFaR at k (chart-arm X before overlay fill). */
  bookCfarSum: number;
  /** Overlay portfolio VAR (sum of Euler components). */
  overlayCfarSum: number;
  /** Ticket CFaR = √(bookCfarSum² + overlayCfarSum²). */
  totalCfarSum: number;
  /** Selected chart X — overlay VAR on overlay fill, else book-arm X. */
  chartX: number;
  byCcy: SolutionCarryLeg[];
}

/** One CCY’s display setpoint for a named portfolio scenario. */
export interface CcyScenarioSetpoint {
  scenarioId: string;
  askFillMode: AskFillMode;
  cfarUsdM: number;
  carryUsdYrM: number;
  bookCfarUsdM: number;
  overlayCfarUsdM: number;
  bookUsdYrM: number;
  overlayUsdYrM: number;
  overlayFcyM: number;
  overlayUsdM: number;
  /** k × peak standing for this scenario — modal walk must reach this S. */
  bookStandingFcyM: number;
  /** Book S × spot — header Book $, never the FCY figure labeled as $. */
  bookStandingUsdM: number;
}

const NAMED_SCENARIO_IDS: readonly SolutionScenarioId[] = [
  'unhedged', 'carryTarget', 'balanced', 'maxCarry', 'maxReturn',
];

/**
 * Chip / header numbers for one CCY at a portfolio scenario.
 * Overlay fill: Unhedged = book section CFaR · $0; named = overlay CFaR · overlay carry.
 * Swap / Both: ticket CFaR · Book+Overlay.
 */
export function ccySetpointFromBreakdown(
  bd: SolutionCarryBreakdown,
  ccy: string,
): CcyScenarioSetpoint | null {
  const leg = bd.byCcy.find(r => r.ccy === ccy);
  if (!leg) return null;
  const overlayFill = bd.askFillMode === 'overlay';
  const unhedged = bd.scenarioId === 'unhedged';
  const cfarUsdM = overlayFill
    ? (unhedged ? leg.bookCfarUsdM : (leg.overlayCfarUsdM || leg.totalCfarUsdM))
    : (leg.totalCfarUsdM || leg.bookCfarUsdM);
  const carryUsdYrM = overlayFill ? leg.overlayUsdYrM : leg.totalUsdYrM;
  return {
    scenarioId: bd.scenarioId,
    askFillMode: bd.askFillMode,
    cfarUsdM,
    carryUsdYrM,
    bookCfarUsdM: leg.bookCfarUsdM,
    overlayCfarUsdM: leg.overlayCfarUsdM,
    bookUsdYrM: leg.bookUsdYrM,
    overlayUsdYrM: leg.overlayUsdYrM,
    overlayFcyM: leg.overlayFcyM,
    overlayUsdM: leg.overlayUsdM,
    bookStandingFcyM: overlayFill ? 0 : leg.bookStandingFcyM,
    bookStandingUsdM: overlayFill ? 0 : leg.bookStandingUsdM,
  };
}

/** Solid-book S the CCY modal must walk to — solution Book S, not live H*. */
export function walkStandingFromSetpoints(
  liveBookS: number,
  setpoints: Record<string, Pick<CcyScenarioSetpoint, 'bookStandingFcyM'>>,
  scenarioId?: string | null,
): number {
  const named = scenarioId != null ? setpoints[scenarioId]?.bookStandingFcyM : undefined;
  const ask = setpoints.carryTarget?.bookStandingFcyM;
  // Overlay publishes S = 0 on purpose. max(|live|, |named|) treated that
  // as "unset" and walked H* (~68 FCY) — the modal then drew a funding
  // book and stamped portfolio CFaR as Carry Target.
  if (typeof named === 'number' && Number.isFinite(named)) return named;
  if (typeof ask === 'number' && Number.isFinite(ask)) return ask;
  return typeof liveBookS === 'number' && Number.isFinite(liveBookS) ? liveBookS : 0;
}

export function ccySetpointsByScenario(
  breakdowns: Record<string, SolutionCarryBreakdown> | null | undefined,
  ccy: string,
): Record<string, CcyScenarioSetpoint> {
  const out: Record<string, CcyScenarioSetpoint> = {};
  if (!breakdowns) return out;
  for (const [id, bd] of Object.entries(breakdowns)) {
    const sp = ccySetpointFromBreakdown(bd, ccy);
    if (sp) out[id] = sp;
  }
  return out;
}

export function serializeLiquidityStrategyInput(
  input: LiquidityStrategyInput,
): SerializedLiquidityStrategyInput {
  return {
    ...input,
    activeLayers: [...(input.activeLayers ?? [])],
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

function isLayerId(v: unknown): v is LayerId {
  return typeof v === 'string' && (LAYER_IDS as readonly string[]).includes(v);
}

function isStrategyId(v: unknown): v is LiquidityStrategyId {
  return typeof v === 'string' && (STRATEGY_IDS as readonly string[]).includes(v);
}

function isScenarioId(v: unknown): v is SolutionScenarioId {
  return typeof v === 'string' && (SCENARIO_IDS as readonly string[]).includes(v);
}

function isBookingMode(v: unknown): v is LiquidityBookingMode {
  return typeof v === 'string' && (BOOKING_MODES as readonly string[]).includes(v);
}

function numberMap(v: unknown, field: string): Record<string, number> | string {
  if (v === undefined || v === null) return {};
  const rec = asRecord(v);
  if (!rec) return `${field} must be an object`;
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(rec)) {
    if (!isFiniteNumber(val)) return `${field}.${key} must be a finite number`;
    out[key] = val;
  }
  return out;
}

function parseShared(v: unknown): SharedGlobals | string {
  const rec = asRecord(v);
  if (!rec) return 'strategyInput.shared must be an object';
  if (!isFiniteNumber(rec.r_USD)) return 'strategyInput.shared.r_USD must be finite';
  if (!isFiniteNumber(rec.σ_P)) return 'strategyInput.shared.σ_P must be finite';
  if (!isFiniteNumber(rec.days)) return 'strategyInput.shared.days must be finite';
  const forecastMonths = rec.forecastMonths;
  return {
    r_USD: rec.r_USD,
    σ_P: rec.σ_P,
    days: rec.days,
    ...(isFiniteNumber(forecastMonths) ? { forecastMonths } : {}),
  };
}

function parseRows(v: unknown): RowState[] | string {
  if (!Array.isArray(v)) return 'strategyInput.rows must be an array';
  if (v.length > EFFICIENT_FRONTIER_LIMITS.maxRows) {
    return `strategyInput.rows exceeds ${EFFICIENT_FRONTIER_LIMITS.maxRows}`;
  }
  const rows: RowState[] = [];
  for (const raw of v) {
    const rec = asRecord(raw);
    if (!rec || typeof rec.ccy !== 'string' || rec.ccy.length === 0) {
      return 'strategyInput.rows entries need a ccy';
    }
    rows.push(raw as RowState);
  }
  return rows;
}

function parseLayers(v: unknown): LayerId[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return 'strategyInput.activeLayers must be an array';
  const out: LayerId[] = [];
  for (const id of v) {
    if (!isLayerId(id)) return `unknown layer '${String(id)}'`;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function parseIncluded(v: unknown): string[] | null | string {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return 'includedCcys must be an array or null';
  if (v.length > EFFICIENT_FRONTIER_LIMITS.maxCcys) {
    return `includedCcys exceeds ${EFFICIENT_FRONTIER_LIMITS.maxCcys}`;
  }
  const out: string[] = [];
  for (const ccy of v) {
    if (typeof ccy !== 'string' || ccy.length === 0 || ccy.length > 8) {
      return 'includedCcys entries must be currency codes';
    }
    if (!out.includes(ccy)) out.push(ccy);
  }
  return out;
}

/**
 * Validate a browser-controlled body. Engines already clamp internally;
 * this stops a caller asking for an unbounded book that pins a server core.
 */
export function parseEfficientFrontierRequest(
  body: unknown,
): { request: EfficientFrontierRequest } | { error: string } {
  const rec = asRecord(body);
  if (!rec) return { error: 'Body must be a JSON object' };

  const rawInput = asRecord(rec.strategyInput);
  if (!rawInput) return { error: 'strategyInput must be an object' };

  const rows = parseRows(rawInput.rows);
  if (typeof rows === 'string') return { error: rows };

  const months = rawInput.months;
  if (!isFiniteNumber(months) || months < 0 || months > EFFICIENT_FRONTIER_LIMITS.maxMonths) {
    return { error: `strategyInput.months must be 0–${EFFICIENT_FRONTIER_LIMITS.maxMonths}` };
  }

  const shared = parseShared(rawInput.shared);
  if (typeof shared === 'string') return { error: shared };

  const activeLayers = parseLayers(rawInput.activeLayers);
  if (typeof activeLayers === 'string') return { error: activeLayers };

  if (!isStrategyId(rec.selectedStrategyId)) {
    return { error: 'selectedStrategyId is not a known funding regime' };
  }
  if (!isFiniteNumber(rec.policyVAR) || rec.policyVAR < 0 || rec.policyVAR > 200) {
    return { error: 'policyVAR must be a finite number in 0–200' };
  }
  if (!isFiniteNumber(rec.carryTargetUsdYr)) {
    return { error: 'carryTargetUsdYr must be a finite number' };
  }
  if (rec.askFillMode != null && !isAskFillMode(rec.askFillMode)) {
    return { error: 'askFillMode must be swap, overlay, or both' };
  }
  if (!isFiniteNumber(rec.scenarioCapUsd) || rec.scenarioCapUsd < 0) {
    return { error: 'scenarioCapUsd must be a finite non-negative number' };
  }
  if (!isBookingMode(rec.bookingMode)) {
    return { error: 'bookingMode must be rolling, term, or stripTerm' };
  }
  if (!isFiniteNumber(rec.forecastMonths) || rec.forecastMonths < 0
    || rec.forecastMonths > EFFICIENT_FRONTIER_LIMITS.maxMonths) {
    return { error: `forecastMonths must be 0–${EFFICIENT_FRONTIER_LIMITS.maxMonths}` };
  }
  if (!isFiniteNumber(rec.confidencePct) || rec.confidencePct < 50 || rec.confidencePct > 99.9) {
    return { error: 'confidencePct must be a finite number in 50–99.9' };
  }

  const includedCcys = parseIncluded(rec.includedCcys);
  if (typeof includedCcys === 'string') return { error: includedCcys };

  const tabNetByCcyUsd = numberMap(rec.tabNetByCcyUsd, 'tabNetByCcyUsd');
  if (typeof tabNetByCcyUsd === 'string') return { error: tabNetByCcyUsd };

  const scenarioId = rec.scenarioId;
  if (scenarioId != null && !isScenarioId(scenarioId)) {
    return { error: 'scenarioId is not a known sweet-spot' };
  }
  const customK = rec.customK;
  if (customK != null && !isFiniteNumber(customK)) {
    return { error: 'customK must be a finite number when set' };
  }
  const selectedPointRaw = rec.selectedPoint == null ? null : asRecord(rec.selectedPoint);
  if (rec.selectedPoint != null && !selectedPointRaw) {
    return { error: 'selectedPoint must be an object' };
  }
  if (selectedPointRaw
    && (!isFiniteNumber(selectedPointRaw.totalCarryUsdYr)
      || !isFiniteNumber(selectedPointRaw.portfolioVarUsd))) {
    return { error: 'selectedPoint needs finite totalCarryUsdYr and portfolioVarUsd' };
  }
  const selectedPoint = selectedPointRaw
    ? {
      totalCarryUsdYr: selectedPointRaw.totalCarryUsdYr as number,
      portfolioVarUsd: selectedPointRaw.portfolioVarUsd as number,
    }
    : null;

  const optionalMap = (key: string) => {
    const parsed = numberMap(rawInput[key], `strategyInput.${key}`);
    return typeof parsed === 'string' ? parsed : parsed;
  };
  const cfarNet = optionalMap('cfarNetByCcyUsd');
  if (typeof cfarNet === 'string') return { error: cfarNet };
  const deskHedge = optionalMap('deskHedgeCarryByCcyUsdM');
  if (typeof deskHedge === 'string') return { error: deskHedge };
  const deskCash = optionalMap('deskCashCarryByCcyUsdM');
  if (typeof deskCash === 'string') return { error: deskCash };
  const deskCip = optionalMap('deskCipByCcyUsdM');
  if (typeof deskCip === 'string') return { error: deskCip };

  const ratesScopeId = rawInput.ratesScopeId;
  if (ratesScopeId !== undefined && typeof ratesScopeId !== 'string') {
    return { error: 'strategyInput.ratesScopeId must be a string' };
  }

  return {
    request: {
      strategyInput: {
        rows,
        months,
        shared,
        activeLayers,
        ...(rawInput.forecastProfile !== undefined
          ? { forecastProfile: rawInput.forecastProfile as SerializedLiquidityStrategyInput['forecastProfile'] }
          : {}),
        ...(rawInput.hedgeSettleByCcy !== undefined
          ? { hedgeSettleByCcy: rawInput.hedgeSettleByCcy as SerializedLiquidityStrategyInput['hedgeSettleByCcy'] }
          : {}),
        ...(rawInput.livePlanByCcy !== undefined
          ? { livePlanByCcy: rawInput.livePlanByCcy as SerializedLiquidityStrategyInput['livePlanByCcy'] }
          : {}),
        ...(Object.keys(cfarNet).length > 0 ? { cfarNetByCcyUsd: cfarNet } : {}),
        ...(rawInput.setup !== undefined
          ? { setup: rawInput.setup as SerializedLiquidityStrategyInput['setup'] }
          : {}),
        ...(rawInput.bookedHedges !== undefined
          ? { bookedHedges: rawInput.bookedHedges as SerializedLiquidityStrategyInput['bookedHedges'] }
          : {}),
        ...(rawInput.preparedByCcy !== undefined
          ? { preparedByCcy: rawInput.preparedByCcy as SerializedLiquidityStrategyInput['preparedByCcy'] }
          : {}),
        ...(rawInput.marketRatesByCcy !== undefined
          ? { marketRatesByCcy: rawInput.marketRatesByCcy as SerializedLiquidityStrategyInput['marketRatesByCcy'] }
          : {}),
        ...(typeof ratesScopeId === 'string' ? { ratesScopeId } : {}),
        ...(rawInput.swapForwardOverlayByCcy !== undefined
          ? { swapForwardOverlayByCcy: rawInput.swapForwardOverlayByCcy as SerializedLiquidityStrategyInput['swapForwardOverlayByCcy'] }
          : {}),
        ...(Object.keys(deskHedge).length > 0 ? { deskHedgeCarryByCcyUsdM: deskHedge } : {}),
        ...(Object.keys(deskCash).length > 0 ? { deskCashCarryByCcyUsdM: deskCash } : {}),
        ...(Object.keys(deskCip).length > 0 ? { deskCipByCcyUsdM: deskCip } : {}),
      },
      selectedStrategyId: rec.selectedStrategyId,
      policyVAR: rec.policyVAR,
      includedCcys,
      tabNetByCcyUsd,
      carryTargetUsdYr: rec.carryTargetUsdYr,
      askFillMode: parseAskFillMode(rec.askFillMode),
      scenarioCapUsd: rec.scenarioCapUsd,
      bookingMode: rec.bookingMode,
      forecastMonths: rec.forecastMonths,
      confidencePct: rec.confidencePct,
      scenarioId: scenarioId == null ? null : scenarioId,
      customK: customK == null ? null : customK,
      selectedPoint,
    },
  };
}

function money(n: number): string {
  if (!Number.isFinite(n)) return 'NaN';
  const sign = n < 0 ? '-' : '+';
  const abs = Math.abs(n);
  if (abs >= 1) return `${sign}$${abs.toFixed(3)}M`;
  return `${sign}$${(abs * 1000).toFixed(1)}k`;
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return 'NaN';
  return `${(n * 100).toFixed(2)}%`;
}

function share(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || Math.abs(whole) < 0.001) {
    return '—';
  }
  return `${((part / whole) * 100).toFixed(0)}%`;
}

function ratePct(n: number | undefined): string {
  return n != null && Number.isFinite(n) ? `${n.toFixed(2)}%` : '—';
}

function includedRow(
  rows: readonly RowState[],
  includedCcys: readonly string[] | null,
): RowState[] {
  return rows.filter(r => (
    r.ccy !== 'USD'
    && CURRENCY_PARAMS[r.ccy]
    && (!includedCcys || includedCcys.includes(r.ccy))
  ));
}

function tabAllCcyNetUsdM(
  tabNetByCcyUsd: Record<string, number>,
  includedCcys: readonly string[] | null,
): number {
  let sum = 0;
  for (const [ccy, v] of Object.entries(tabNetByCcyUsd)) {
    if (ccy === 'USD') continue;
    if (includedCcys && !includedCcys.includes(ccy)) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) sum += v;
  }
  return sum;
}

function overlayOn(activeLayers: Set<LayerId>, mvFrontier: EfficientCarryVarFrontier | null): boolean {
  return (
    bufferLevelOf(activeLayers) === 'portfolio'
    && activeLayers.has('carryOptim')
    && (mvFrontier?.capLegs.length ?? 0) > 0
  );
}

/**
 * Unhedged + one term overlay, scaled on the existing overlay walk.
 * Far CIP stays the book rate-vol arm — do not stretch pink with overlay t.
 */
function overlayTermWalkFrontier(input: {
  results: readonly LiquidityStrategyResult[];
  rows: readonly RowState[];
  engine: PortfolioFrontierEngine;
  capLegs?: readonly EfficientCarryLeg[] | null;
  mv?: EfficientCarryVarFrontier | null;
  carryTargetUsdYr: number;
  bookFar?: PortfolioCarryFrontier['farPoints'];
}): PortfolioCarryFrontier | null {
  const ask = input.carryTargetUsdYr;
  const tAsk = overlayTToHitCarry({
    capLegs: input.capLegs,
    targetUsdYrM: ask,
  });
  const maxScale = Math.max(1.2, Number.isFinite(tAsk) ? tAsk * 1.25 : 1.2);
  const unfunded = input.results.find(r => r.strategy.id === 'unfunded');
  const overlayFcy = overlayFcyByCcyFromLegs(input.capLegs);
  let walk: PortfolioCarryFrontier | null = null;
  if (unfunded && overlayFcy) {
    const liq = buildPortfolioLiquidityFrontier({
      result: unfunded,
      strategy: unfunded.strategy,
      rows: input.rows,
      engine: input.engine,
      overlayFcyByCcy: overlayFcy,
      overlaySweetT: 0,
      maxScale,
    });
    const built = toPortfolioCarryFrontier(liq);
    if (built.points.length >= 3) walk = built;
  }
  if (!walk && input.mv?.ray.length) {
    walk = overlayRayFrontier(input.mv, { maxT: maxScale });
  }
  if (!walk || walk.points.length < 3) return null;
  if (!input.bookFar?.length) return walk;
  return { ...walk, farPoints: input.bookFar };
}

/** Cap-mix FCY for the existing unhedged overlay walk (one term, scale t). */
function overlayFcyByCcyFromLegs(
  legs: readonly EfficientCarryLeg[] | null | undefined,
): Record<string, number> | undefined {
  if (!legs?.length) return undefined;
  const out: Record<string, number> = {};
  for (const l of legs) {
    if (Number.isFinite(l.fcyM) && Math.abs(l.fcyM) > 1e-9) out[l.ccy] = l.fcyM;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function legCapNote(leg: EfficientCarryLeg, varCapUsdM: number): string {
  const harvest = (leg.mu < 0 && leg.usdM < 0) || (leg.mu > 0 && leg.usdM > 0);
  const spot = CURRENCY_PARAMS[leg.ccy]?.spot ?? 1;
  const baseUsd = Math.abs(leg.baseFcyM ?? 0) * spot;
  const levCeil = Math.max(0, varCapUsdM) * OVERLAY_MAX_LEG_LEVERAGE;
  const bookCeil = baseUsd > 1e-6 && !harvest
    ? baseUsd * OVERLAY_MAX_BASE_MULTIPLE
    : Number.POSITIVE_INFINITY;
  const ceil = Math.min(levCeil, bookCeil);
  const hit = Number.isFinite(ceil) && Math.abs(leg.usdM) >= ceil - 0.02;
  if (harvest) {
    return `harvest ${leg.side}  cap=3×VAR${hit ? ' HIT' : ''}`;
  }
  const book = Number.isFinite(bookCeil) ? ` 2×base=${money(bookCeil)}` : '';
  return `diversifier ${leg.side}  cap=min(3×VAR,${book})${hit ? ' HIT' : ''}`;
}

function l1Share(values: readonly number[]): number[] {
  const den = values.reduce((s, v) => s + Math.abs(v), 0);
  if (!(den > 1e-12)) return values.map(() => 0);
  return values.map(v => v / den);
}

function muDamp(mu: number): number {
  return Math.min(1, Math.abs(mu) / OVERLAY_MATERIALITY_MU);
}

export function computeCarryBreakdown(
  req: EfficientFrontierRequest,
  rows: readonly RowState[],
  result: Pick<EfficientFrontierResult, 'results' | 'mvFrontier' | 'solutionFrontier' | 'universeFrontier'>,
  engine: PortfolioFrontierEngine,
  liftOverlayT?: number,
): SolutionCarryBreakdown | null {
  const book = result.results.find(r => r.strategy.id === req.selectedStrategyId)
    ?? result.results.find(r => r.strategy.id !== 'unfunded');
  const mv = result.mvFrontier;
  const frontier = result.solutionFrontier;
  if (!book || !frontier) return null;

  const askFillMode = parseAskFillMode(req.askFillMode);
  const scenarioId = resolveFrontierScenarioId(req.scenarioId);
  const chartOriginX = tabAllCcyNetUsdM(req.tabNetByCcyUsd, req.includedCcys);
  const universeHold = result.universeFrontier?.points.find(p => Math.abs(p.k - 1) < 1e-6) ?? null;
  const point = pointForScenario({
    frontier,
    scenarioId,
    policyCapUsd: req.scenarioCapUsd,
    carryTargetUsdYr: req.carryTargetUsdYr,
    confidencePct: req.confidencePct,
    askFillMode,
    capLegs: mv?.capLegs,
    bookHoldY: universeHold?.totalCarryUsdYr,
    chartOriginX,
    customPoint: scenarioId === 'custom' && req.customK != null
      ? (frontier.points.find(p => Math.abs(p.k - req.customK!) < 1e-3) ?? null)
      : null,
  });
  if (!point) return null;

  logFrontierChart('api-scenario-point', {
    fill: askFillMode,
    scenarioId,
    chartOriginX,
    selection: frontierPointCoords(point),
    carryTargetUsdYr: req.carryTargetUsdYr,
    policyCapUsd: req.scenarioCapUsd,
  });

  const fixedOverlayT = liftOverlayT ?? (
    result.universeFrontier
      ? resolveAskFillLiftT({
        askFillMode,
        capLegs: mv?.capLegs,
        universePoints: result.universeFrontier.points,
        policyCapUsd: req.scenarioCapUsd,
        carryTargetUsdYr: req.carryTargetUsdYr,
      })
      : undefined
  );
  const overlayFill = askFillMode === 'overlay' && frontier.walk === 'overlay';
  const overlayT = overlayTForPoint({
    point,
    frontier,
    policyCapUsd: req.scenarioCapUsd,
    scenarioId,
    fixedOverlayT,
  });
  const k = scenarioId === 'unhedged' || overlayFill ? 0 : Math.max(0, point.k);
  const legs = mv?.capLegs.length && overlayT > 1e-12
    ? scaleOverlayLegs(mv.capLegs, overlayT)
    : [];
  const mixW = l1Share(legs.map(l => l.usdM));
  const overlayFcy = overlayFcyByCcyFromLegs(mv?.capLegs);
  const unfunded = result.results.find(r => r.strategy.id === 'unfunded');
  const priced = overlayFill && unfunded && overlayFcy
    ? priceBooksAtScale({
      result: unfunded,
      rows,
      engine,
      scale: overlayT,
      overlayFcyByCcy: overlayFcy,
      overlaySweetT: 0,
    })
    : priceBooksAtScale({
      result: book,
      rows,
      engine,
      scale: k,
    });
  const plotBy = new Map(priced.map(p => [p.ccy, p]));
  const ccys = [...new Set([
    ...legs.map(l => l.ccy),
    ...book.byCcy.map(c => c.ccy),
    ...rows.map(r => r.ccy),
  ])];
  const armX = Math.abs(k - 1) < 1e-6
    ? (universeHold?.portfolioVarUsd ?? point.portfolioVarUsd)
    : (
      result.universeFrontier?.points.find(p => Math.abs(p.k - k) < 1e-3)?.portfolioVarUsd
      ?? point.portfolioVarUsd
    );
  const originX = frontier.points[0]?.portfolioVarUsd ?? 0;
  const bookPort = overlayFill
    ? Math.max(0, originX)
    : Math.max(0, armX);
  const overlayPort = overlayFill
    ? Math.max(0, point.portfolioVarUsd)
    : overlayPortfolioVarUsdM(legs);
  const ticket = overlayFill
    ? overlayPort
    : Math.hypot(bookPort, Math.max(0, overlayPort));
  const chartX = overlayFill ? overlayPort : bookPort;

  const draft: { ccy: string; bookCfarUsdM: number; overlayCfarUsdM: number }[] = [];
  for (const ccy of ccys) {
    if (ccy === 'USD') continue;
    const leg = legs.find(l => l.ccy === ccy);
    const plot = plotBy.get(ccy);
    draft.push({
      ccy,
      bookCfarUsdM: overlayFill
        ? Math.max(0, plot?.sectionUsdM ?? 0)
        : (plot?.cfarUsdM ?? 0),
      overlayCfarUsdM: overlayFill
        ? (plot?.cfarUsdM ?? 0)
        : (leg?.componentVarUsdM ?? 0),
    });
  }
  const totalCfarBy = overlayFill
    ? Object.fromEntries(draft.map(r => [r.ccy, r.overlayCfarUsdM]))
    : splitTicketCfarByCcy(draft, bookPort, overlayPort);

  const byCcy: SolutionCarryLeg[] = [];
  let bookSum = 0;
  let overlaySum = 0;
  let totalSum = 0;
  for (const ccy of ccys) {
    if (ccy === 'USD') continue;
    const leg = legs.find(l => l.ccy === ccy);
    const plot = plotBy.get(ccy);
    const pricedCarry = plot?.carryUsdYrM ?? 0;
    const overlayUsdYrM = overlayFill ? pricedCarry : (leg?.carryUsdYrM ?? 0);
    const row = rows.find(r => r.ccy === ccy);
    const bookUsdYrM = overlayFill ? 0 : pricedCarry;
    const bookStandingFcyM = overlayFill ? 0 : (plot?.standing ?? 0);
    const spot = ccySpotRate(ccy);
    const bookSignedCashUsdYrM = row && Math.abs(bookStandingFcyM) > 1e-9
      ? fundingSwapCashDeltaUsdYr(
        bookStandingFcyM, spot, row.r_FCY, engine.shared.r_USD, row.r_OD,
      )
      : 0;
    const totalUsdYrM = bookUsdYrM + overlayUsdYrM;
    const w = leg ? (mixW[legs.indexOf(leg)] ?? 0) : 0;
    const bookCfarUsdM = overlayFill
      ? Math.max(0, plot?.sectionUsdM ?? 0)
      : (plot?.cfarUsdM ?? 0);
    const overlayCfarUsdM = overlayFill
      ? (plot?.cfarUsdM ?? 0)
      : (leg?.componentVarUsdM ?? 0);
    bookSum += bookUsdYrM;
    overlaySum += overlayUsdYrM;
    totalSum += totalUsdYrM;
    byCcy.push({
      ccy,
      bookUsdYrM,
      overlayUsdYrM,
      totalUsdYrM,
      overlayUsdM: leg?.usdM ?? 0,
      overlayFcyM: leg?.fcyM ?? 0,
      mixWeight: w,
      bookStandingFcyM,
      bookStandingUsdM: bookStandingFcyM * spot,
      bookSignedCashUsdYrM,
      bookCfarUsdM,
      overlayCfarUsdM,
      totalCfarUsdM: totalCfarBy[ccy] ?? 0,
    });
  }
  return {
    scenarioId,
    k,
    overlayT,
    askFillMode,
    chartY: point.totalCarryUsdYr,
    askY: req.carryTargetUsdYr,
    bookSum,
    overlaySum,
    totalSum,
    bookCfarSum: bookPort,
    overlayCfarSum: overlayPort,
    totalCfarSum: ticket,
    chartX,
    byCcy,
  };
}

function logCurrencyLegBreakdown(
  req: EfficientFrontierRequest,
  rows: readonly RowState[],
  result: EfficientFrontierResult,
  engine: PortfolioFrontierEngine,
): void {
  const payload = result.carryBreakdown;
  const book = result.results.find(r => r.strategy.id === req.selectedStrategyId)
    ?? result.results.find(r => r.strategy.id !== 'unfunded');
  const mv = result.mvFrontier;
  const frontier = result.solutionFrontier;
  if (!payload || !book) {
    console.info(`${TAG} -- table identity -- skipped (no carryBreakdown)`);
    return;
  }

  const liveBy = new Map(book.byCcy.map(c => [c.ccy, c]));
  const rowBy = new Map(rows.map(r => [r.ccy, r]));
  const legs = mv?.capLegs.length && payload.overlayT > 1e-12
    ? scaleOverlayLegs(mv.capLegs, payload.overlayT)
    : [];
  const liftedHold = frontier?.points.find(p => Math.abs(p.k - 1) < 1e-6);
  const selectedY = frontier?.points.reduce<typeof frontier.points[number] | null>((best, p) => {
    if (!Number.isFinite(p.k)) return best;
    if (!best) return p;
    return Math.abs(p.k - payload.k) < Math.abs(best.k - payload.k) ? p : best;
  }, null);

  console.info(`${TAG} -- table identity (same payload as the UI) --`);
  console.info(
    `${TAG}   scenario=${payload.scenarioId}  fill=${payload.askFillMode}`
    + `  k=${payload.k.toFixed(3)}`
    + `  overlayT=${payload.overlayT.toFixed(3)}`
    + (payload.askFillMode === 'overlay'
      ? '  chart Y = overlay carry on the term-swap walk  table = Overlay'
      : '  Total = Book(k) + Overlay(t)  (same Y as the chart point)'),
  );
  console.info(
    `${TAG}   Ask ${money(payload.askY)}  Book ${money(payload.bookSum)}`
    + `  Overlay ${money(payload.overlaySum)}  Total ${money(payload.totalSum)}`
    + `  chartY ${money(payload.chartY)}`
    + (Math.abs(payload.totalSum - (payload.bookSum + payload.overlaySum)) > 1e-9
      ? '  !! Total ≠ Book+Overlay'
      : '')
    + (payload.askFillMode === 'overlay'
      ? (Math.abs(payload.chartY - payload.overlaySum) > 1e-6
        ? '  !! chartY ≠ Overlay'
        : '  (= Overlay)')
      : (Math.abs(payload.chartY - payload.totalSum) > 1e-6
        ? '  !! chartY ≠ table Total'
        : '  (= table Total)')),
  );
  console.info(
    `${TAG}   CFaR  Book ${money(payload.bookCfarSum)}`
    + `  Overlay ${money(payload.overlayCfarSum)}`
    + `  Total √(Book²+Overlay²) ${money(payload.totalCfarSum)}`
    + `  chartX ${money(payload.chartX)}`
    + (payload.askFillMode === 'overlay'
      && Math.abs(payload.overlayCfarSum - payload.chartX) > 1e-6
      ? '  !! Overlay CFaR ≠ chartX'
      : '')
    + (Math.abs(payload.totalCfarSum - payload.chartY) < 0.05
      ? '  !! chartX ≈ chartY — CFaR is not Target Carry'
      : ''),
  );
  console.info(
    `${TAG}   selectedY ${money(payload.chartY)}`
    + `  X=${money(payload.chartX)}`
    + `  k=${payload.k.toFixed(3)}`,
  );
  if (
    payload.scenarioId === 'carryTarget'
    && Math.abs(payload.chartY - payload.askY) > 0.05
  ) {
    console.info(
      `${TAG}   !! chart Y ${money(payload.chartY)} ≠ Ask ${money(payload.askY)}`
      + ` — ask is off the arm.`,
    );
  }
  if (payload.askFillMode === 'overlay') {
    if (liftedHold && Math.abs(payload.overlayT - 1) > 1e-6) {
      console.info(
        `${TAG}   3× mix t=1 Y=${money(liftedHold.totalCarryUsdYr)}`
        + `  (selected t=${payload.overlayT.toFixed(3)})`,
      );
    }
  } else if (liftedHold && Math.abs(payload.k - 1) > 1e-6) {
    console.info(
      `${TAG}   liveHold k=1 Y=${money(liftedHold.totalCarryUsdYr)}`
      + `  (not the selected point)`,
    );
  }

  logAskFillModeContract(payload);

  let stripSum = 0;
  for (const row of payload.byCcy) {
    const live = liveBy.get(row.ccy);
    const cap = mv?.capLegs.find(l => l.ccy === row.ccy);
    const leg = legs.find(l => l.ccy === row.ccy);
    const deskRow = rowBy.get(row.ccy);
    const swapCash = live?.swapInterestUsdYrM ?? 0;
    const cip = live?.swapPointsUsdYrM ?? 0;
    const stripY = stripDisplayedCarryUsdM({
      swapInterestUsdYrM: swapCash,
      swapPointsUsdYrM: cip,
      overlayCarryUsdYrM: row.overlayUsdYrM,
    });
    stripSum += stripY;
    const mu = cap?.mu ?? leg?.mu ?? 0;
    const harvest = !!leg && ((mu < 0 && leg.usdM < 0) || (mu > 0 && leg.usdM > 0));
    const baseFcy = cap?.baseFcyM ?? overlayBookBaseFcyM({
      cash: deskRow?.cash ?? 0,
      payout: deskRow?.payout ?? 0,
      collections: deskRow?.collections,
      carry_target: deskRow?.carry_target,
      cash_floor: deskRow?.cash_floor,
      fxExposureM: deskRow?.spot,
    });
    const rUsd = engine.shared.r_USD;
    const rOd = deskRow?.r_OD ?? CURRENCY_PARAMS[row.ccy]?.r_OD;
    const overlayUsd = row.overlayUsdM;
    const overlayFcy = row.overlayFcyM;
    const finalFcy = baseFcy + overlayFcy;
    const debitMu = rOd != null ? (rOd - rUsd) / 100 : mu;
    const usedDebit = finalFcy < 0 && rOd != null;
    const usedRate = usedDebit ? debitMu : mu;
    const flags: string[] = [];
    if (Math.abs(row.totalUsdYrM - (row.bookUsdYrM + row.overlayUsdYrM)) > 1e-9) {
      flags.push(
        `leg Total ${money(row.totalUsdYrM)} ≠ Buffer ${money(row.bookUsdYrM)}`
        + ` + Overlay ${money(row.overlayUsdYrM)}`,
      );
    }
    if (
      payload.askFillMode !== 'overlay'
      && leg
      && Math.abs(leg.carryUsdYrM - row.overlayUsdYrM) > 1e-6
    ) {
      flags.push(
        `scaled overlayμ ${money(leg.carryUsdYrM)} ≠ payload ${money(row.overlayUsdYrM)}`,
      );
    }
    if (Math.abs(row.bookSignedCashUsdYrM - row.bookUsdYrM) > 0.02) {
      flags.push(
        `signed cash on Book S ${money(row.bookSignedCashUsdYrM)} ≠ Buffer Carry ${money(row.bookUsdYrM)}`
        + ` (path Σ vs single-S Δr)`,
      );
    }

    console.info(
      `${TAG}   ${row.ccy.padEnd(4)}`
      + `  mix=${(row.mixWeight * 100).toFixed(0).padStart(4)}%`
      + `  Book S ${row.bookStandingFcyM.toFixed(2)} FCY / $${row.bookStandingUsdM.toFixed(1)}M`
      + `  signed cash ${money(row.bookSignedCashUsdYrM)}`
      + `  Buffer=${money(row.bookUsdYrM)}`
      + `  Overlay=${money(row.overlayUsdYrM)}`
      + `  Total=${money(row.totalUsdYrM)}`
      + `  CFaR Book=${money(row.bookCfarUsdM)} Overlay=${money(row.overlayCfarUsdM)}`
      + ` Total=${money(row.totalCfarUsdM)}`
      + `  ${harvest ? 'harvest' : 'div/flat'} ${leg?.side ?? 'flat'}`,
    );
    console.info(
      `${TAG}        Total ${money(row.totalUsdYrM)}`
      + ` = Buffer ${money(row.bookUsdYrM)} (${share(row.bookUsdYrM, row.totalUsdYrM)})`
      + ` + Overlay ${money(row.overlayUsdYrM)} (${share(row.overlayUsdYrM, row.totalUsdYrM)})`,
    );
    if (live) {
      console.info(
        `${TAG}        desk strip  swap ${money(swapCash)} + CIP ${money(cip)}`
        + ` = ${money(swapCash + cip)}  + overlay ${money(row.overlayUsdYrM)}`
        + ` = strip ${money(stripY)}  (not Buffer, not table Total)`,
      );
    }
    if (cap || Math.abs(overlayUsd) > 1e-9) {
      const muTimesUsd = mu * overlayUsd;
      const rateTimesUsd = usedRate * overlayUsd;
      console.info(
        `${TAG}        OVERLAY  t=${payload.overlayT.toFixed(3)} × capUsd ${money(cap?.usdM ?? 0)}`
        + ` → ${money(overlayUsd)}  fcy=${overlayFcy.toFixed(3)}`
        + `  baseFcy=${baseFcy.toFixed(3)} + overlayFcy=${overlayFcy.toFixed(3)}`
        + ` = finalFcy=${finalFcy.toFixed(3)}`,
      );
      console.info(
        `${TAG}              μ=${pct(mu)}  debit (r_OD−r_USD)=${pct(debitMu)}`
        + `  rate used=${pct(usedRate)} because finalFcy ${usedDebit ? '<0 debit' : '≥0 credit'}`
        + `  overlayμ ${money(row.overlayUsdYrM)}`
        + `  naive μ×usd ${money(muTimesUsd)}  rate×usd ${money(rateTimesUsd)}`,
      );
    }
    for (const flag of flags) {
      console.info(`${TAG}        !! ${flag}`);
    }
  }

  console.info(
    `${TAG}   Σ Book ${money(payload.bookSum)} + Overlay ${money(payload.overlaySum)}`
    + ` = Total ${money(payload.totalSum)}`
    + `  Ask ${money(payload.askY)}`
    + (Math.abs(payload.chartY - payload.askY) <= 0.05 ? '  Y=Ask' : '  Y≠Ask')
    + `  live-strip ${money(stripSum)} (Swap+CIP+overlay — not the table)`,
  );
  logCfarSigmaAndModalSetpoints(payload);
}

/** Expected k / t / chart X·Y / modal chip per Fill Ask mode. */
function logAskFillModeContract(payload: SolutionCarryBreakdown): void {
  const fill = payload.askFillMode;
  console.info(`${TAG} -- mode contract (${fill}) --`);
  if (fill === 'overlay') {
    console.info(
      `${TAG}   expect  k=0  overlayT=Ask  Book S=0  Book Y=$0`
      + `  chartY=Overlay  chartX=overlay CFaR`
      + `  modal chip=overlay CFaR · overlay carry  walk S=0  pinVar=no`,
    );
    if (Math.abs(payload.k) > 1e-3) {
      console.info(`${TAG}   !! k=${payload.k.toFixed(3)} — overlay must stay at unhedged book`);
    }
    if (Math.abs(payload.bookSum) > 1e-3) {
      console.info(`${TAG}   !! Book ${money(payload.bookSum)} — overlay Book Y must be $0`);
    }
    if (payload.byCcy.some(r => Math.abs(r.bookStandingFcyM) > 0.05)) {
      console.info(`${TAG}   !! Book S ≠ 0 on overlay — modal would walk a funding book`);
    }
    if (Math.abs(payload.chartX - payload.overlayCfarSum) > 0.02) {
      console.info(
        `${TAG}   !! chartX ${money(payload.chartX)} ≠ overlay CFaR ${money(payload.overlayCfarSum)}`,
      );
    }
    return;
  }
  console.info(
    `${TAG}   expect  k and overlay t(X) walk together  chartY=Book+Overlay  chartX=book CFaR`
    + `  modal chip=ticket CFaR · Total  walk S=Book S  pinVar=no`,
  );
  if (Math.abs(payload.chartX - payload.bookCfarSum) > 0.02) {
    console.info(
      `${TAG}   !! chartX ${money(payload.chartX)} ≠ book CFaR ${money(payload.bookCfarSum)}`,
    );
  }
}

function logCfarSigmaAndModalSetpoints(payload: SolutionCarryBreakdown): void {
  const sumBook = payload.byCcy.reduce((s, r) => s + r.bookCfarUsdM, 0);
  const sumOv = payload.byCcy.reduce((s, r) => s + r.overlayCfarUsdM, 0);
  const sumTot = payload.byCcy.reduce((s, r) => s + r.totalCfarUsdM, 0);
  console.info(`${TAG} -- CFaR identity --`);
  console.info(
    `${TAG}   Σ legs   Book ${money(sumBook)}  Overlay ${money(sumOv)}  Total ${money(sumTot)}`,
  );
  console.info(
    `${TAG}   payload  Book ${money(payload.bookCfarSum)}  Overlay ${money(payload.overlayCfarSum)}`
    + `  ticket ${money(payload.totalCfarSum)}  chartX ${money(payload.chartX)}`,
  );
  if (Math.abs(sumOv - payload.overlayCfarSum) > 0.05) {
    console.info(
      `${TAG}   !! Σ Overlay CFaR legs ${money(sumOv)} ≠ payload ${money(payload.overlayCfarSum)}`,
    );
  }
  if (Math.abs(sumTot - payload.totalCfarSum) > 0.05) {
    console.info(
      `${TAG}   !! Σ ticket CFaR legs ${money(sumTot)} ≠ payload ${money(payload.totalCfarSum)}`,
    );
  }
  if (Math.abs(sumBook - payload.bookCfarSum) > 0.05) {
    console.info(
      `${TAG}   !! Σ Book CFaR legs ${money(sumBook)} ≠ Port Book ${money(payload.bookCfarSum)}`
      + `  (legs=standalone / Euler · payload=diversified Port — not a chip)`,
    );
  }

  console.info(`${TAG} -- CCY modal setpoints (chip · walk S · local cut) --`);
  for (const row of payload.byCcy) {
    const sp = ccySetpointFromBreakdown(payload, row.ccy);
    if (!sp) continue;
    const overlayFill = payload.askFillMode === 'overlay';
    console.info(
      `${TAG}   ${row.ccy.padEnd(4)}`
      + `  chip ${money(sp.cfarUsdM)} · ${money(sp.carryUsdYrM)}`
      + `  walk S ${sp.bookStandingFcyM.toFixed(2)} FCY`
      + (overlayFill
        ? '  cut=none (chips only, stay at origin)'
        : `  cut=Buffer ${money(sp.bookUsdYrM)} (not Total ${money(sp.carryUsdYrM)})`)
      + (Math.abs(sp.cfarUsdM - payload.chartX) > 0.05
        ? `  chipX≠chartX ${money(payload.chartX)} (this-name, not Port)`
        : ''),
    );
  }
}

function logFrontierWalk(
  req: EfficientFrontierRequest,
  activeLayers: Set<LayerId>,
  rows: readonly RowState[],
  result: EfficientFrontierResult,
  engine: PortfolioFrontierEngine,
  elapsedMs: number,
): void {
  const layers = [...activeLayers].sort().join(',') || '(none)';
  const included = rows.map(r => r.ccy).join(' ') || '(none)';
  console.info(`${TAG} ══════════════════════════════════════`);
  console.info(
    `${TAG} Policy VAR ${money(req.policyVAR)}  r_USD ${req.strategyInput.shared.r_USD.toFixed(2)}%`
    + `  booking=${req.bookingMode}  months=${req.strategyInput.months}`
    + `  Target Carry ${money(req.carryTargetUsdYr)}/yr`
    + `  fill=${parseAskFillMode(req.askFillMode)}`,
  );
  console.info(`${TAG} layers: ${layers}`);
  console.info(`${TAG} included: ${included}`);
  console.info(`${TAG} CFaR-tab All-CCY Net ${money(result.tabAllCcyNetUsdM)}`);

  const mv = result.mvFrontier;
  if (!mv) {
    console.info(`${TAG} -- Σ⁻¹μ overlay -- skipped (portfolio layer off or no FCY rows)`);
  } else {
    console.info(`${TAG} -- Σ⁻¹μ overlay --`);
    console.info(
      `${TAG}   sweet t=${mv.sweet.t.toFixed(3)}  overlayCarry=${money(mv.sweet.carryUsdYrM)}`
      + `  var=${money(mv.sweet.varUsdM)}  varBinding=${mv.sweet.varBinding}`
      + `  carryBinding=${mv.sweet.carryBinding}`
      + `  capBreachedAtZero=${mv.sweet.capBreachedAtZeroOverlay}`,
    );
    console.info(
      `${TAG}   Policy-VAR fill t=1  carry=${money(mv.cap.carryUsdYrM)}  var=${money(mv.cap.varUsdM)}`
      + `  capLegs=${mv.capLegs.length}`,
    );
    for (const leg of mv.capLegs) {
      const damp = muDamp(leg.mu);
      const harvest = (leg.mu < 0 && leg.usdM < 0) || (leg.mu > 0 && leg.usdM > 0);
      const dust = Math.abs(leg.mu) < OVERLAY_MATERIALITY_MU;
      const noBase = Math.abs(leg.baseFcyM ?? 0) < 1e-6;
      console.info(
        `${TAG}   ${leg.ccy.padEnd(4)} μ=${pct(leg.mu).padStart(8)}`
        + `  damp=${damp.toFixed(2)}`
        + `  baseFcy=${(leg.baseFcyM ?? 0).toFixed(3)}`
        + `  capUsd=${money(leg.usdM)}  capFcy=${leg.fcyM.toFixed(3)}`
        + `  carry=${money(leg.carryUsdYrM)}  varComp=${money(leg.componentVarUsdM)}`
        + `  ${legCapNote(leg, mv.varCapUsdM)}`
        + (harvest && (dust || noBase) && Math.abs(leg.usdM) > 1
          ? '  !! FAKE harvest (dust μ or empty book still filled 3×VAR)'
          : ''),
      );
    }
    if (mv.ray.length > 0) {
      const rayBits = mv.ray.map(p => (
        `t=${p.t.toFixed(2)} Y=${money(p.carryUsdYrM)} X=${money(p.varUsdM)}`
      ));
      console.info(`${TAG}   ray: ${rayBits.join(' | ')}`);
    }
  }

  const uni = result.universeFrontier;
  if (!uni) {
    console.info(`${TAG} -- book-scale arm -- skipped`);
  } else {
    const hold = uni.points.find(p => Math.abs(p.k - 1) < 1e-6);
    const first = uni.points[0];
    const last = uni.points[uni.points.length - 1];
    console.info(`${TAG} -- book-scale arm (selected=${req.selectedStrategyId}) — |cash| on k×S, not desk Buffer --`);
    console.info(
      `${TAG}   points=${uni.points.length}`
      + (first ? `  origin k=${first.k.toFixed(2)} Y=${money(first.totalCarryUsdYr)} X=${money(first.portfolioVarUsd)}` : '')
      + (hold ? `  hold k=1 Y=${money(hold.totalCarryUsdYr)} X=${money(hold.portfolioVarUsd)}` : '')
      + (last ? `  last k=${last.k.toFixed(2)} Y=${money(last.totalCarryUsdYr)} X=${money(last.portfolioVarUsd)}` : ''),
    );
  }

  const sol = result.solutionFrontier;
  if (!sol) {
    console.info(`${TAG} -- lifted Total Carry -- skipped`);
  } else if (!overlayOn(activeLayers, mv)) {
    console.info(`${TAG} -- lifted Total Carry -- identity (overlay off)`);
  } else {
    const hold = sol.points.find(p => Math.abs(p.k - 1) < 1e-6);
    const hi = sol.points.reduce<typeof sol.points[number] | null>((best, p) => (
      !best || p.totalCarryUsdYr > best.totalCarryUsdYr ? p : best
    ), null);
    const fill = parseAskFillMode(req.askFillMode);
    const overlayTNote = fill === 'overlay'
      ? 'unhedged book + one term overlay'
      : 'book k and overlay t(X) walk together';
    console.info(
      fill === 'overlay'
        ? `${TAG} -- overlay-fill chart arm — unhedged + one term overlay (same pricer as term swap) --`
        : `${TAG} -- lifted chart arm — |cash|+overlay t(X) --`,
    );
    console.info(
      `${TAG}   hold Y=${hold ? money(hold.totalCarryUsdYr) : '—'}  X=${hold ? money(hold.portfolioVarUsd) : '—'}`
      + `  peak Y=${hi ? money(hi.totalCarryUsdYr) : '—'}  X=${hi ? money(hi.portfolioVarUsd) : '—'}`,
    );
    const originX = sol.points[0]?.portfolioVarUsd ?? 0;
    const plot = chartPathTrace(sol.points, originX, true);
    const stem = plot.drawn[1];
    const hasZeroStem = plot.pinApplied
      && stem != null
      && Math.abs(stem.x - plot.originX) <= 1e-3
      && Math.abs(stem.y) > 1e-3;
    const sample = (p: { x: number; y: number; k?: number }) => (
      (typeof p.k === 'number' ? `k=${p.k.toFixed(2)} ` : '')
      + `X=${money(p.x)} Y=${money(p.y)}`
    );
    console.info(`${TAG} -- why this curve --`);
    console.info(
      `${TAG}   fill=${fill}  ${overlayTNote}`
      + (fill === 'overlay'
        ? '  chart X=overlay CFaR  Y=overlay carry'
        : '  chart X=book CFaR  Y=Book(k)+Overlay'),
    );
    console.info(
      `${TAG}   origin ${plot.liftedOrigin ? 'lifted' : 'at $0'}`
      + ` Y=${money(plot.originY)} at X=${money(plot.originX)}`
      + `  pin$0=${plot.pinApplied ? 'yes' : 'no'}`
      + (hasZeroStem
        ? `  stem $0 → first priced Y=${money(stem!.y)}`
        : ''),
    );
    console.info(
      `${TAG}   k-stack: ${plot.nNearOrigin} samples within ${money(plot.nearOriginTol)} of origin`
      + `  ΔX=${money(plot.nearOriginDx)}  ΔY=${money(plot.nearOriginDy)}`,
    );
    if (plot.hookRisk) {
      console.info(
        `${TAG}   !! k-stack at unhedged CFaR — tiny ΔX / large ΔY is the hook`
        + `  (spline through ${plot.nNearOrigin} pts would zig-zag)`,
      );
    }
    console.info(
      `${TAG}   plot: raw ${plot.nRaw} → standing ${plot.nSkyline} → drawn ${plot.nDrawn}`
      + (plot.pinApplied ? '  pin$0' : '')
      + (plot.hookRisk
        ? '  (near-vertical k-stack — polyline, no cubic)'
        : ''),
    );
    if (plot.rawHead.length > 0) {
      console.info(`${TAG}   raw head: ${plot.rawHead.map(sample).join(' | ')}`);
    }
    if (plot.drawn.length > 0) {
      console.info(`${TAG}   drawn: ${plot.drawn.map(sample).join(' → ')}`);
    }
    const bal = pricedBalancedVertex(sol.points, originX);
    if (bal) {
      const walkHit = sol.points.find(p => (
        Math.abs(p.k - bal.k) < 1e-9
        && Math.abs(p.portfolioVarUsd - bal.portfolioVarUsd) < 1e-8
        && Math.abs(p.totalCarryUsdYr - bal.totalCarryUsdYr) < 1e-8
      ));
      console.info(
        `${TAG}   Balanced k=${bal.k.toFixed(2)} X=${money(bal.portfolioVarUsd)} Y=${money(bal.totalCarryUsdYr)}`
        + `  walk row=${walkHit ? 'yes' : 'NO'}`,
      );
    }
    const farHold = (sol.farPoints ?? []).find(p => Math.abs(p.k - 1) < 1e-6);
    const farYs = (sol.farPoints ?? []).map(p => p.totalCarryUsdYr).filter(Number.isFinite);
    const farMin = farYs.length > 0 ? Math.min(...farYs) : null;
    console.info(
      `${TAG} -- far CIP arm — signed cash + points, no overlay --`
      + (farHold ? `  hold Y=${money(farHold.totalCarryUsdYr)}  X=${money(farHold.portfolioVarUsd)}` : '')
      + (farMin != null ? `  min Y=${money(farMin)}` : '')
      + `  n=${sol.farPoints?.length ?? 0}`,
    );
    const raw = frontierMonotoneStats(sol.points);
    const xSpan = sol.points.length > 0
      ? Math.max(...sol.points.map(p => p.portfolioVarUsd))
        - Math.min(...sol.points.map(p => p.portfolioVarUsd))
      : 0;
    console.info(
      `${TAG}   monotone: n=${raw.n}  X-backtracks=${raw.xBacktracks}  Y-dips=${raw.yDips}`
      + `  envelope n=${raw.envelopeN}  dropped=${raw.n - raw.envelopeN}`
      + (xSpan < 1e-6
        ? '  (flat CFaR — chart keeps the k-walk)'
        : (raw.xBacktracks > 0 || raw.yDips > 0
          ? '  !! raw walk has a dip'
          : '')),
    );
  }

  const regimes = Object.entries(result.regimeSolutions);
  if (regimes.length === 0) {
    console.info(`${TAG} -- regimes -- none`);
  } else {
    console.info(`${TAG} -- regimes @ ${resolveFrontierScenarioId(req.scenarioId)} --`);
    for (const [id, s] of regimes) {
      console.info(`${TAG}   ${id.padEnd(18)} Y=${money(s.totalCarryUsdYr)}  X=${money(s.portUsdM)}`);
    }
  }

  logCurrencyLegBreakdown(req, rows, result, engine);

  console.info(`${TAG} done in ${elapsedMs}ms`);
}

export function computeEfficientFrontier(
  req: EfficientFrontierRequest,
  opts?: { log?: boolean },
): EfficientFrontierResult {
  const started = Date.now();
  const activeLayers = new Set<LayerId>(req.strategyInput.activeLayers);
  const strategyInput: LiquidityStrategyInput = {
    ...req.strategyInput,
    activeLayers,
  };
  const results = evaluateLiquidityStrategies(strategyInput);
  const rows = includedRow(strategyInput.rows, req.includedCcys);
  const netUsd = tabAllCcyNetUsdM(req.tabNetByCcyUsd, req.includedCcys);

  const engine: PortfolioFrontierEngine = {
    months: strategyInput.months,
    shared: strategyInput.shared,
    activeLayers,
    forecastProfile: strategyInput.forecastProfile,
    hedgeSettleByCcy: strategyInput.hedgeSettleByCcy,
    cfarNetByCcyUsd: req.tabNetByCcyUsd,
    setup: strategyInput.setup,
    bookedHedges: strategyInput.bookedHedges,
    preparedByCcy: strategyInput.preparedByCcy,
    marketRatesByCcy: strategyInput.marketRatesByCcy,
    ratesScopeId: strategyInput.ratesScopeId,
    swapForwardOverlayByCcy: strategyInput.swapForwardOverlayByCcy,
  };

  let mvFrontier: EfficientCarryVarFrontier | null = null;
  if (bufferLevelOf(activeLayers) === 'portfolio' && rows.length >= 1) {
    const rUsd = strategyInput.shared.r_USD;
    const tenorMonths = req.bookingMode === 'rolling'
      ? 1
      : Math.max(1, req.forecastMonths);
    const ccys = rows.map(r => r.ccy);
    const mu = rows.map(r => (
      impliedPortfolioRFcyPct(
        r.ccy, r.r_FCY, rUsd, strategyInput.marketRatesByCcy, tenorMonths,
      ) - rUsd
    ) / 100);
    const basesFcy = rows.map(r => overlayBookBaseFcyM({
      cash: r.cash,
      payout: r.payout,
      collections: r.collections,
      carry_target: r.carry_target,
      cash_floor: r.cash_floor,
      fxExposureM: r.spot,
    }));
    const rOd = rows.map(r => r.r_OD);
    const fixedCfarUsdM = activeLayers.has('cfarCover')
      ? rows.map(r => Math.abs(strategyInput.cfarNetByCcyUsd?.[r.ccy] ?? 0))
      : undefined;
    const floorFcy = activeLayers.has('floorH')
      ? rows.map(r => r.cash_floor)
      : undefined;
    mvFrontier = buildEfficientCarryVarFrontier({
      ccys,
      mu,
      varCapUsdM: req.policyVAR,
      basesFcy,
      rOd,
      r_USD: rUsd,
      fixedCfarUsdM,
      floorFcy,
    });
  }

  let universeFrontier: PortfolioCarryFrontier | null = null;
  if (bufferLevelOf(activeLayers) === 'portfolio' && rows.length >= 1) {
    const conservativeBook = pickConservativeFundingBook(results, req.selectedStrategyId);
    const book = results.find(r => r.strategy.id === req.selectedStrategyId) ?? conservativeBook;
    if (book) {
      const liq = buildPortfolioLiquidityFrontier({
        result: book,
        strategy: book.strategy,
        rows,
        engine,
      });
      universeFrontier = toPortfolioCarryFrontier(liq);
    } else {
      const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
      universeFrontier = computePortfolioCarryFrontier({
        rows,
        shared: strategyInput.shared,
        activeLayers,
        forecastProfile: strategyInput.forecastProfile,
        hedgeSettleByCcy: strategyInput.hedgeSettleByCcy,
        cfarNetByCcyUsd: req.tabNetByCcyUsd,
        marketRatesByCcy: strategyInput.marketRatesByCcy,
        policyVAR: maxTier,
        unhedgedCfarUsdM: netUsd,
      }, 48, 1, true);
    }
  }

  const askFillMode = parseAskFillMode(req.askFillMode);
  const askFillT = universeFrontier
    ? resolveAskFillLiftT({
      askFillMode,
      capLegs: mvFrontier?.capLegs,
      universePoints: universeFrontier.points,
      policyCapUsd: req.scenarioCapUsd,
      carryTargetUsdYr: req.carryTargetUsdYr,
    })
    : undefined;

  // Overlay fill = unhedged book + one scaled term overlay (same pricer
  // as term swap). Carry Target sits on that walk at Ask Y.
  // Swap and Both are the same single book-scale walk
  // (`liftFrontierToTotalCarry` → `plotStandingCarryArm` → `chartOpenPath`).
  // Both walks overlay t with X. Swap parks overlay at t=1. Origin pin
  // is chartOpenPath ($0 @ unhedged CFaR); every later vertex is
  // Book(k)+Overlay(1). Do not invent Y = k × hold Total.
  const overlayWalk = overlayOn(activeLayers, mvFrontier)
    && askFillMode === 'overlay'
    ? overlayTermWalkFrontier({
      results,
      rows,
      engine,
      capLegs: mvFrontier?.capLegs,
      mv: mvFrontier,
      carryTargetUsdYr: req.carryTargetUsdYr,
      bookFar: universeFrontier?.farPoints,
    })
    : null;
  let solutionFrontier: PortfolioCarryFrontier | null = null;
  if (!universeFrontier) {
    solutionFrontier = null;
  } else if (askFillMode === 'overlay' && overlayWalk) {
    solutionFrontier = overlayWalk;
  } else if (askFillMode === 'swap') {
    // Swap = the operating funding book, no overlay lift. (The hedge-
    // coverage Δ-walk at fixed k = 1 — `toSwapHedgeCoverageFrontier` — is
    // the target model, but the scenario-pricing pipeline still assumes
    // k = notional scale, so it needs a coordinated rework first.)
    solutionFrontier = universeFrontier;
  } else if (!overlayOn(activeLayers, mvFrontier)) {
    solutionFrontier = universeFrontier;
  } else {
    // Both: book k + overlay t(X) walk together.
    solutionFrontier = liftFrontierToTotalCarry({
      frontier: universeFrontier,
      capLegs: mvFrontier!.capLegs,
      policyCapUsd: req.scenarioCapUsd,
    });
  }

  const scenarioId = resolveFrontierScenarioId(req.scenarioId);
  const scenarioBreakdowns: Record<string, SolutionCarryBreakdown> = {};
  if (solutionFrontier) {
    const ids = new Set<SolutionScenarioId>(NAMED_SCENARIO_IDS);
    if (scenarioId === 'custom') ids.add('custom');
    for (const id of ids) {
      const bd = computeCarryBreakdown(
        { ...req, scenarioId: id },
        rows,
        { results, mvFrontier, solutionFrontier, universeFrontier },
        engine,
        askFillT,
      );
      if (bd) scenarioBreakdowns[id] = bd;
    }
  }
  const carryBreakdown = scenarioBreakdowns[scenarioId]
    ?? computeCarryBreakdown(req, rows, {
      results, mvFrontier, solutionFrontier, universeFrontier,
    }, engine, askFillT);

  const regimeChartCfar: Record<string, RegimeChartCfarUsd> = {};
  const conservativeBook = pickConservativeFundingBook(results, req.selectedStrategyId);
  const hold = universeFrontier?.points.find(p => Math.abs(p.k - 1) < 1e-6) ?? null;
  for (const r of results) {
    if (r.strategy.id === 'unfunded') {
      regimeChartCfar[r.strategy.id] = { sumUsdM: netUsd, portUsdM: netUsd };
      continue;
    }
    if (conservativeBook && r.strategy.id === conservativeBook.strategy.id && hold) {
      regimeChartCfar[r.strategy.id] = {
        sumUsdM: hold.portfolioVarUsd,
        portUsdM: hold.portfolioVarUsd,
      };
      continue;
    }
    if (rows.length < 1) {
      regimeChartCfar[r.strategy.id] = { sumUsdM: netUsd, portUsdM: netUsd };
      continue;
    }
    regimeChartCfar[r.strategy.id] = priceRegimeChartCfar({
      result: r,
      strategy: r.strategy,
      rows,
      engine,
    });
  }

  const regimeSolutions: Record<string, RegimeSolutionUsd> = {};
  if (solutionFrontier) {
    const capLegs = overlayOn(activeLayers, mvFrontier) ? mvFrontier?.capLegs : undefined;
    const customPoint = scenarioId === 'custom' && req.customK != null
      ? (solutionFrontier.points.find(p => Math.abs(p.k - req.customK!) < 1e-3)
        ?? solutionFrontier.points[0]
        ?? null)
      : null;
    const selected = results.find(r => r.strategy.id === req.selectedStrategyId);
    const bookHoldY = universeFrontier?.points.find(p => Math.abs(p.k - 1) < 1e-6)?.totalCarryUsdYr;
    for (const r of results) {
      if (r.strategy.id === 'unfunded') continue;
      if (selected && r.strategy.id === selected.strategy.id) {
        if (req.selectedPoint) {
          regimeSolutions[r.strategy.id] = {
            totalCarryUsdYr: req.selectedPoint.totalCarryUsdYr,
            portUsdM: req.selectedPoint.portfolioVarUsd,
          };
        } else if (carryBreakdown) {
          regimeSolutions[r.strategy.id] = {
            totalCarryUsdYr: carryBreakdown.chartY,
            portUsdM: carryBreakdown.chartX,
          };
        } else {
          const point = pointForScenario({
            frontier: solutionFrontier,
            scenarioId,
            policyCapUsd: req.scenarioCapUsd,
            carryTargetUsdYr: req.carryTargetUsdYr,
            confidencePct: req.confidencePct,
            askFillMode: parseAskFillMode(req.askFillMode),
            capLegs,
            bookHoldY,
            customPoint,
            chartOriginX: netUsd,
          });
          if (point) {
            regimeSolutions[r.strategy.id] = {
              totalCarryUsdYr: point.totalCarryUsdYr,
              portUsdM: point.portfolioVarUsd,
            };
          }
        }
        continue;
      }
      const liq = buildPortfolioLiquidityFrontier({
        result: r,
        strategy: r.strategy,
        rows,
        engine,
      });
      const raw = toPortfolioCarryFrontier(liq);
      const point = pointForScenario({
        frontier: askFillMode === 'overlay' || askFillMode === 'swap'
          ? raw
          : liftFrontierToTotalCarry({
            frontier: raw,
            capLegs,
            policyCapUsd: req.scenarioCapUsd,
          }),
        scenarioId,
        policyCapUsd: req.scenarioCapUsd,
        carryTargetUsdYr: req.carryTargetUsdYr,
        confidencePct: req.confidencePct,
        askFillMode,
        capLegs,
        bookHoldY,
        customPoint,
        chartOriginX: netUsd,
      });
      if (!point) continue;
      regimeSolutions[r.strategy.id] = {
        totalCarryUsdYr: point.totalCarryUsdYr,
        portUsdM: point.portfolioVarUsd,
      };
    }
  }

  const result: EfficientFrontierResult = {
    results,
    mvFrontier,
    universeFrontier,
    solutionFrontier,
    tabAllCcyNetUsdM: netUsd,
    regimeSolutions,
    regimeChartCfar,
    carryBreakdown,
    scenarioBreakdowns,
  };
  if (opts?.log !== false) {
    logFrontierWalk(req, activeLayers, rows, result, engine, Date.now() - started);
  }
  return result;
}
