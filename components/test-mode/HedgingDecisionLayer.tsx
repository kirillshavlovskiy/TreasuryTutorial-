'use client';

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { DeskIcon } from '@/components/DeskIcons';
import { DeskStepper } from '@/components/DeskStepper';
import { createPortal } from 'react-dom';
import {
  ExposureHedgePathChart,
  type HedgePathPrepareAction,
  type HedgePathSummaryMetrics,
} from '@/components/test-mode/ExposureHedgePathChart';
import {
  chipsFromPathSummary,
  HedgeStagingHeader,
  pathChartDraftDirty,
} from '@/components/test-mode/HedgeStagingHeader';
import {
  DEFAULT_FORECAST_PROFILE,
  monthlyFxFlowSeriesLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import type { RowState } from '@/lib/fx-buffer';
import type { FcyComputedRow } from '@/lib/dashboard-model';
import type { LiquidityBookingMode, LiquiditySizingBasis } from '@/lib/liquidity-ladder';
import { LiquiditySwapDecision } from '@/components/LiquiditySwapDecision';
import { OrgBookedTradesPush } from '@/components/test-mode/OrgBookedTradesPush';
import { TradeTicketPanel } from '@/components/test-mode/TradeTicketPanel';
import { ExecutionMonitorPanel } from '@/components/test-mode/ExecutionMonitorPanel';
import {
  ticketRoleLabel,
  ticketTradeDateIso,
  ticketValueDateIso,
  fillCounterpartyFor,
  POST_FILL_TAPE_TAIL_MS,
  ticketPlacedAtMs,
  unsignedLocalM,
  spotReferencedLegShift,
  ticketBlotterLabel,
  ticketFillWorkingLabel,
  ticketGoodTillLabel,
  ticketLimitLevelLabel,
  ticketTradeSide,
} from '@/lib/test-mode/ticket-desk-label';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  hedgeBasisNotionalLocalM,
  hedgeRatioForNumber,
  inferHedgePathBasis,
  resolveChartMonthlyFlows,
  resyncHedgeRatiosToNearestRegime,
  type HedgePathBasisId,
} from '@/lib/test-mode/exposure-hedge-path';
import {
  buildHedgeVarSummary,
  clearLiveBulletForCcy,
  clearPreparedHedgeForCcy,
  equalVarLinearHedgeNotionalLocalM,
  AUTOMATED_HEDGE_LIMIT_USD_M,
  autoFillAllowedByPolicy,
  GROUP_HEDGE_SCOPE,
  OVER_AUTOMATED_LIMIT_NOTE,
  hedgeTicketExecutionState,
  type HedgeTicketExecutionState,
  decisionCcyOrderCounts,
  decisionStructureCaption,
  quoteAfterFill,
  spotReferencedFillQuote,
  ticketNotionalUsdM,
  usdPerLocalFromQuote,
  isEditableWorkingOrder,
  isLiveHedgeTicket,
  isMarketExecutedHedgeTicket,
  hedgeRestingKey,
  modeledHedgeCarryUsdM,
  newHedgeTicketId,
  overlayRiskFromFxBook,
  restingOrderTriggersAt,
  restingOrderHitSide,
  proposeBookHedge,
  setPreparedHedgeForCcy,
  packageForStructure,
  livePreparedHedge,
  preparedHedgeFromBookedTickets,
  stripFullyExecuted,
  stripExecutionStarted,
  stripPackageForTicketView,
  ticketOpensAsStrip,
  releasedPreparedByCcy,
  stampSourcePackage,
  stagedFxHedgeCarryByCcyUsdM,
  varSetupWithLineUncertainty,
  mixCoverTargetLocalM,
  bookedNotionalLocalM,
  committedHedgeNotionalLocalM,
  hedgeCoverSnapshot,
  composeDecisionBookTicket,
  scalePreparedHedgeToCover,
  scalePreparedHedgesBySizerMove,
  isPreparedStrip,
  stripScheduleEndsFromPrepared,
  stripScheduleWeightsFromPrepared,
  stripSchedulesAgree,
  type HedgeSizerSnapshot,
  type HedgeIpaQuote,
  type HedgeTicket,
  type PreparedHedgeLeg,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import {
  blotterLifecycleEvent,
  dedupeMonitorEvents,
  eventsForBeat,
  explainWorkingOrders,
  monitorSnapshotKey,
  type ExecutionLogEvent,
} from '@/lib/test-mode/execution-monitor';
import { publishExecutionLogs } from '@/lib/test-mode/execution-log-client';
import {
  fetchExecutionJournal,
  fetchExecutionLogEvents,
  fetchMatchingHeartbeat,
  inferWorkbenchTaskId,
  matchingServerIsLive,
  saveExecutionJournal,
  startMatchingProcess,
  syncMatchingOrders,
  type MatchingHeartbeatView,
} from '@/lib/test-mode/matching-process-client';
import { assignImpliedCarryFromSwapPoints } from '@/lib/test-mode/cash-carry-analytics';
import { buildTenorRiskLadder } from '@/lib/test-mode/tenor-risk-ladder';
import {
  pipSizeOf,
  walkSpot,
  type SimSpotQuote,
} from '@/lib/test-mode/sim-ticket-price';
import {
  capTapeHistory,
  parkMidAwayFromStopLimit,
  restingTapeAnchorMid,
  retainTicketOverlayKey,
  tapeInstrument,
  tapeQuoteKey,
  tapeQuoteKeyCandidates,
} from '@/lib/test-mode/tape-candles';

/** A blank IPA quote to hang a note on when a ticket has none yet. */
const EMPTY_IPA_QUOTE: HedgeIpaQuote = {
  strike: null,
  strikeInput: '',
  premiumUsd: null,
  premiumPercent: null,
  fxSpot: null,
  fxOutright: null,
  atmVolPercent: null,
  impliedVolPercent: null,
  deltaPercent: null,
};
import {
  resolveMarketRatesForCcy,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import {
  buildRollingHedgeEdges,
  bulletMaturityForForecast,
  clearRollingStripForCcy,
  hasRollingStripForCcy,
  collapseDuplicateStripSlots,
  mergeOptimisticHedgeTickets,
  mergeRollingStripIntoBook,
  mergeStripTicketsIntoBook,
  needsRollingHedges,
  proposeRollingHedgeTickets,
  hedgeTicketsRemovedBy,
  removeHedgeTicketOrStrip,
  retireOneOrder,
  resyncBookedRollingStrips,
  sizingForHedgePathBasis,
  stripLadderMonths,
  varSetupForHedgeStructure,
  varSetupForPathHedgeRegime,
  type ForecastHedgeStructure,
  type RollingHedgeEdge,
} from '@/lib/test-mode/rolling-hedge';
import {
  type RiskPerspective,
  type RiskPerspectiveTabStat,
} from '@/components/test-mode/RiskPerspectiveSelector';
import {
  DEFAULT_VAR_SETUP,
  computeAnalyticsVarUsdM,
  computeParametricVarUsdM,
  horizonMonths,
  monthlyVolForSetup,
  VAR_EXPOSURE_OPTIONS,
  VAR_HORIZON_OPTIONS,
  type VarExposureBasis,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

const HEDGE_STEP_PCT = 10;
const RESTING_ORDER_POLL_MS = 5_000;
/** Recorded tape read before each fill, so its candle has real ticks on both sides. */
const FILL_TAPE_LEAD_MS = 5 * 60_000;
/** Log working-order snapshots this often (6 × 5s ≈ 30s). Fills always log. */
const EXEC_HEARTBEAT_BEATS = 6;

function stampLiveFillOnStripTickets(
  tickets: readonly HedgeTicket[],
  edited: HedgeTicket,
  stripFills?: readonly { edgeIndex: number; rate: number | null }[],
): HedgeTicket[] {
  // Evidence of an actual execution is status/filledAtMs — NEVER orderHit,
  // which is set on every ticket left through the UI (it names the typed
  // tile). Treating it as a fill stamped filledAtMs onto strip legs that
  // never filled, putting invented execution times on the tiles.
  const liveFill =
    (edited.filledAtMs != null && Number.isFinite(edited.filledAtMs))
    || edited.status === 'booked';
  if (!liveFill) return [...tickets];
  return tickets.map(t => {
    const fill = stripFills?.find(f => f.edgeIndex === (t.stripEdgeIndex ?? 0));
    // A leg already executed keeps its own print. When the caller says
    // which edges this execution covered, an edge that is not in that list
    // was not traded now — re-stamping it would move a past execution's
    // time and rate onto this click (trading the same leg twice).
    if (stripFills != null && !fill) return t;
    const px =
      (fill?.rate != null && Number.isFinite(fill.rate) ? fill.rate : null)
      ?? t.ipaQuote?.fxOutright
      ?? edited.ipaQuote?.fxOutright
      ?? null;
    return {
      ...t,
      status: 'booked',
      orderHit: edited.orderHit ?? t.orderHit,
      orderSide: edited.orderSide ?? t.orderSide,
      filledAtMs: edited.filledAtMs ?? t.filledAtMs ?? Date.now(),
      counterparty: edited.counterparty ?? t.counterparty,
      ipaQuote: {
        ...(t.ipaQuote ?? edited.ipaQuote ?? EMPTY_IPA_QUOTE),
        fxSpot: edited.ipaQuote?.fxSpot ?? t.ipaQuote?.fxSpot ?? null,
        fxOutright: px,
      },
    };
  });
}

export type TapeHistoryPoint = SimSpotQuote & {
  t: number;
  /** Read back from Postgres for an open booking's story — kept past the live keep window. */
  recorded?: boolean;
};

function fmtLocal(v: number, ccy: string): string {
  const abs = Math.abs(v).toFixed(2);
  const sign = v >= 0 ? '+' : '−';
  if (ccy === 'EUR') return `${sign}€${abs}M`;
  if (ccy === 'PLN') return `${sign}zł${abs}M`;
  if (ccy === 'GBP') return `${sign}£${abs}M`;
  return `${sign}${abs}M ${ccy}`;
}

function fmtVarK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

/** fmtVarK is magnitude-only past the $ sign — negative carry/M2M need the sign in front. */
function fmtSignedVarK(usdM: number): string {
  return fmtVarK(Math.abs(usdM)).replace('$', usdM >= 0 ? '+$' : '−$');
}

/**
 * Minimal dashed-underline click-to-apply control (Hedge Structuring card) —
 * "VaR-neutral · click to apply" style from the design: no border/background,
 * just a dashed emerald underline, matching the mockup exactly.
 */
function QuickApplyReadout({
  label,
  valueLocalM,
  ccy,
  varUsdM,
  disabled,
  onApply,
}: {
  label: string;
  valueLocalM: number;
  ccy: string;
  varUsdM: number;
  disabled: boolean;
  onApply: () => void;
}) {
  const empty = Math.abs(valueLocalM) < 1e-9;
  return (
    <button
      type="button"
      disabled={disabled || empty}
      onClick={onApply}
      title={`Click → apply ${label} as target · ${fmtLocal(valueLocalM, ccy)} · ${fmtVarK(varUsdM)}`}
      className="flex flex-col items-start gap-1 border-0 border-b border-dashed border-emerald-500/50 bg-transparent pb-0.5 text-left disabled:cursor-not-allowed disabled:border-transparent disabled:opacity-40"
    >
      <span className="text-[9px] uppercase tracking-wide text-emerald-400/80">
        {label} · click to apply
      </span>
      <span className="font-mono text-xs text-emerald-300">
        {fmtLocal(valueLocalM, ccy)}
      </span>
    </button>
  );
}

/** Hedge add is % of Total expected (Target) — 0–100%. */
const MAX_HEDGE_PCT = 100;

function clampPct(pct: number): number {
  return Math.min(MAX_HEDGE_PCT, Math.max(0, pct));
}

function tenorLabel(id: VarHorizonId | null): string | null {
  if (!id) return null;
  return VAR_HORIZON_OPTIONS.find(h => h.id === id)?.label ?? id;
}

function ticketLabel(t: HedgeTicket): string {
  return ticketBlotterLabel(t);
}

function filledTicketForDraft(
  booked: readonly HedgeTicket[],
  draft: HedgeTicket,
): HedgeTicket | null {
  if (booked.some(t => t.id === draft.id)) return null;
  return booked.find(t =>
    t.status === 'booked'
    && t.ccy === draft.ccy
    && t.limitRate != null
    && (
      (draft.ocoGroupId != null && t.ocoGroupId === draft.ocoGroupId)
      || (
        draft.limitRate != null
        && t.limitRate === draft.limitRate
        && (draft.orderHit == null || t.orderHit === draft.orderHit)
      )
    ),
  ) ?? null;
}

function isFreeBookComposeTicket(draft: HedgeTicket): boolean {
  return (
    draft.status == null
    && draft.filledAtMs == null
    && draft.limitRate == null
    && draft.ocoGroupId == null
  );
}

/** Overlay package for Book / blotter view. A free compose ticket never inherits the live strip. */
function preparedForDecisionTicketPanel(
  draft: HedgeTicket,
  booked: readonly HedgeTicket[],
  staged: PreparedHedgeProfile | undefined,
): PreparedHedgeProfile | null {
  if (draft.stripId) {
    const bookedStamp = booked.find(
      t =>
        t.stripId === draft.stripId
        && t.sourcePackage?.structure === 'strip'
        && (t.sourcePackage.legs?.length ?? 0) >= 2,
    )?.sourcePackage;
    if (
      bookedStamp
      && bookedStamp.structure === 'strip'
      && bookedStamp.legs.length >= 2
      && !(
        staged
        && (staged.preparedFor === 'carry' || staged.preparedFor === 'liquidity')
        && staged.legs.length >= bookedStamp.legs.length
      )
    ) {
      return bookedStamp;
    }
    // Last resort: DERIVE the package from the legs that are actually
    // booked. The `sourcePackage` stamp only ever rides on the first ticket
    // of a submission, so a strip whose stamp never landed (legs booked
    // one at a time, stamp dropped on a rehydrate) had no package at all
    // unless the desk clicked Restage to populate `staged` — which is why
    // restaging looked mandatory to wire strip legs into the ticket modal.
    // The booked legs are the authority on what the strip IS; they need no
    // staging step to be readable.
    return staged ?? bookedStamp ?? stripPackageForTicketView(booked, draft);
  }
  if (draft.sourcePackage) {
    return { ...draft.sourcePackage, coverLocalM: draft.amountLocalM };
  }
  if (!staged) return null;
  if (isPreparedStrip(staged)) return null;
  return { ...staged, coverLocalM: draft.amountLocalM };
}

function ocoSiblingOf(
  booked: readonly HedgeTicket[],
  ticket: HedgeTicket,
): HedgeTicket | null {
  if (!ticket.ocoGroupId) return null;
  return booked.find(t => t.id !== ticket.id && t.ocoGroupId === ticket.ocoGroupId) ?? null;
}

/**
 * Which OCO leg opens as the panel's draft ticket.
 *
 * A FILLED leg always wins: the panel derives its fill display (status row,
 * fill price/time, tape marker) from the PRIMARY ticket, so opening the
 * cancelled take-profit after the stop fired showed a FILLED blotter row
 * whose panel had no fill price, no fill time, no marker — and still drew
 * the dead TP as a live level. Only when neither leg has filled does the
 * take-profit open first (so both pads label correctly pre-fill).
 */
function ocoDraftPrimary(
  booked: readonly HedgeTicket[],
  ticket: HedgeTicket,
): { primary: HedgeTicket; sibling: HedgeTicket | null } {
  const sibling = ocoSiblingOf(booked, ticket);
  if (!sibling) return { primary: ticket, sibling: null };
  if (ticket.status === 'booked') return { primary: ticket, sibling };
  if (sibling.status === 'booked') return { primary: sibling, sibling: ticket };
  if (ticket.bracketRole === 'takeProfit' || sibling.bracketRole !== 'takeProfit') {
    return { primary: ticket, sibling };
  }
  return { primary: sibling, sibling: ticket };
}

/** Flat, sortable list of every booked / scheduled ticket — the desk blotter. */
function TicketBlotter({
  tickets,
  border,
  head,
  muted,
}: {
  tickets: readonly HedgeTicket[];
  border: string;
  head: string;
  muted: string;
}) {
  const rowGrid =
    'grid w-full min-w-[64rem] grid-cols-[5.4rem_5.4rem_5.6rem_minmax(7.5rem,1fr)_minmax(7.5rem,1fr)_5rem_4.8rem_5rem_5.2rem_4.4rem] items-baseline gap-x-2 px-3';
  return (
    <div className={`border-t ${border}`}>
      <div className="overflow-x-auto">
        <div className={`${rowGrid} border-b ${border} py-1.5 ${head}`}>
          <span className="text-[9px] font-medium uppercase tracking-wide">
            Trade date
          </span>
          <span className="text-[9px] font-medium uppercase tracking-wide">
            Value date
          </span>
          <span className="text-[9px] font-medium uppercase tracking-wide">
            Type
          </span>
          <span className="text-right text-[9px] font-medium uppercase tracking-wide">
            Buy
          </span>
          <span className="text-right text-[9px] font-medium uppercase tracking-wide">
            Sell
          </span>
          <span className="text-right text-[9px] font-medium uppercase tracking-wide">
            Rate
          </span>
          <span className="text-[9px] font-medium uppercase tracking-wide">
            Cpty
          </span>
          <span className="text-[9px] font-medium uppercase tracking-wide">
            Status
          </span>
          <span className="text-right text-[9px] font-medium uppercase tracking-wide">
            Premium
          </span>
          <span className="text-right text-[9px] font-medium uppercase tracking-wide">
            VaR
          </span>
        </div>
        {tickets.length === 0 ? (
          <p className={`px-3 py-3 font-mono text-[10px] ${muted}`}>
            No tickets booked yet.
          </p>
        ) : (
          tickets.map(t => {
            const live = isLiveHedgeTicket(t);
            // Executed: the rate it booked (a spot-referenced order books
            // spot print + points, not its spot limit). Working: its level.
            const dealRate =
              (isMarketExecutedHedgeTicket(t) ? t.ipaQuote?.fxOutright : null)
              ?? t.limitRate
              ?? t.ipaQuote?.fxOutright
              ?? t.ipaQuote?.strike
              ?? null;
            const localAbs = Math.abs(t.amountLocalM);
            // Counter amount comes off the deal rate, converted through the
            // pair's own quote convention — not a spot lookup.
            const usdPerLocal =
              dealRate != null && dealRate > 0
                ? usdPerLocalFromQuote(t.ccy, dealRate)
                : 0;
            const localLeg = unsignedLocalM(t.ccy, localAbs);
            const usdLeg =
              usdPerLocal > 0 ? `$${(localAbs * usdPerLocal).toFixed(2)}M` : '—';
            const sellsFcy = ticketTradeSide(t) === 'Sell';
            const buyLeg = sellsFcy ? usdLeg : localLeg;
            const sellLeg = sellsFcy ? localLeg : usdLeg;
            const tradeDate = ticketTradeDateIso(t);
            return (
              <div
                key={t.id}
                className={`${rowGrid} border-b ${border} py-1.5 font-mono text-[11px] tabular-nums`}
              >
                <span className={tradeDate ? 'text-slate-300' : muted}>
                  {tradeDate ?? '—'}
                </span>
                <span className="text-slate-400">{ticketValueDateIso(t)}</span>
                <span className="min-w-0 truncate text-slate-300" title={ticketLabel(t)}>
                  {ticketRoleLabel(t)}
                </span>
                <span className="text-right text-emerald-300">{buyLeg}</span>
                <span className="text-right text-rose-300">{sellLeg}</span>
                <span className="text-right text-slate-400">
                  {dealRate != null && dealRate > 0
                    ? dealRate.toFixed(dealRate >= 20 ? 3 : 5)
                    : '—'}
                </span>
                <span
                  className={t.counterparty ? 'text-sky-300' : muted}
                  title={
                    t.counterparty
                      ? undefined
                      : 'No dealer recorded — order has not filled, or it filled on the tape'
                  }
                >
                  {t.counterparty ?? '—'}
                </span>
                <span
                  className={
                    t.status === 'cancelled'
                      ? 'text-slate-400'
                      : live
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                  }
                >
                  {t.status === 'cancelled'
                    ? 'CANCELLED'
                    : t.stripId != null
                    ? live
                      ? 'Strip leg'
                      : 'Strip · working'
                    : live
                      ? 'Booked'
                      : 'Working'}
                </span>
                <span className="text-right text-slate-400">
                  {t.ipaQuote?.premiumUsd != null
                    ? `$${(t.ipaQuote.premiumUsd / 1000).toFixed(1)}K`
                    : '—'}
                </span>
                <span className="text-right font-semibold text-slate-200">
                  {fmtVarK(t.varUsdM)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Strip leg shaping — how the target notional splits across legs.
 * `optimized` = derived from a real prepared strip this component didn't
 * build (e.g. the Cash Carry WAM shape-search) — settle/share come from
 * that package's actual legs, not a formula, and no preset button is "on".
 */
type StripShaping = 'equal' | 'front' | 'carry' | 'optimized';

/** Per-CCY structuring UI state — independent of the committed prepared profile. */
interface StructCfg {
  /** Draft structure — not staged until Stage (or restage of an existing package). */
  structure: ForecastHedgeStructure;
  legCount: number;
  shaping: StripShaping;
  /** Settle month per leg — editable, may drift from the shaping preset. */
  t: number[];
  /** Share % per leg (of target) — editable, may not sum to 100. */
  sh: number[];
}

/** n settle months, equally spaced, last leg pinned to Tf (never left short). */
function stripSettleMonths(n: number, tf: number): number[] {
  const T = tf > 0 ? tf : 1;
  return Array.from({ length: n }, (_, i) => {
    const k = i + 1;
    return k === n ? T : Math.max(0.5, Math.round(((k * T) / n) * 2) / 2);
  });
}

/**
 * Share weights (0–100, summing to 100) for a shaping preset.
 * `equal` = flat; `front` = front-loaded (early legs bigger, 1/(i+1)^1.4);
 * `carry` = back-loaded (later legs — longer tenor — carry more, i+1).
 */
function stripShareWeights(n: number, shaping: StripShaping): number[] {
  const w = Array.from({ length: n }, (_, i) =>
    shaping === 'equal' ? 1 : shaping === 'front' ? 1 / Math.pow(i + 1, 1.4) : i + 1,
  );
  const s = w.reduce((a, b) => a + b, 0);
  const out = w.map(x => Math.round((x / s) * 200) / 2);
  out[n - 1] = +(100 - out.slice(0, n - 1).reduce((a, b) => a + b, 0)).toFixed(1);
  return out;
}

/** Rescale arbitrary (possibly off-100) shares back to summing 100. */
function rebalanceShares(shares: readonly number[]): number[] {
  const s = shares.reduce((a, b) => a + b, 0);
  if (s <= 0) return shares.map(() => +(100 / shares.length).toFixed(1));
  const out = shares.map(x => Math.round((x / s) * 200) / 2);
  out[out.length - 1] = +(
    100 - out.slice(0, -1).reduce((a, b) => a + b, 0)
  ).toFixed(1);
  return out;
}

/** {t, sh} preset for a structure/legCount/shaping combination. */
export function structPreset(
  structure: ForecastHedgeStructure,
  legCount: number,
  shaping: StripShaping,
  tf: number,
): { t: number[]; sh: number[] } {
  return structure === 'bullet'
    ? { t: [tf > 0 ? tf : 1], sh: [100] }
    : { t: stripSettleMonths(legCount, tf), sh: stripShareWeights(legCount, shaping) };
}

function fmtShare(v: number): string {
  return `${(Math.round(v * 10) / 10).toFixed(v % 1 ? 1 : 0)}%`;
}

/** Cancellations kept for the notification bell — newest first. */
const CANCELLED_NOTICE_LIMIT = 50;

const LEG_STATE_CLASS: Record<HedgeTicketExecutionState, string> = {
  FILLED: 'font-semibold text-emerald-300',
  WORKING: 'font-semibold text-amber-300',
  HELD: 'font-semibold text-sky-300',
  REJECTED: 'font-semibold text-rose-300',
  CANCELLED: 'font-semibold text-slate-400',
  EXPIRED: 'font-semibold text-slate-400',
};

/**
 * Order actually booked for staged leg `i`, or null while the leg is only
 * staged. A strip leg matches on `stripEdgeIndex`; a bullet's single leg
 * matches the one live non-strip cover.
 */
function bookedForLegIndex(
  bookedForCcy: readonly HedgeTicket[],
  isStrip: boolean,
  i: number,
): HedgeTicket | null {
  if (isStrip) {
    const matches = bookedForCcy.filter(
      t => t.stripId && (t.stripEdgeIndex ?? 0) === i,
    );
    const cover =
      matches.find(t => !t.bracketRole && isMarketExecutedHedgeTicket(t))
      ?? matches.find(t => !t.bracketRole);
    if (cover) return cover;
    const filled = matches.find(
      t => hedgeTicketExecutionState(t, Date.now()) === 'FILLED',
    );
    return filled ?? matches[0] ?? null;
  }
  if (i !== 0) return null;
  return bookedForCcy.find(t => !t.stripId && t.status !== 'cancelled') ?? null;
}

/**
 * Draft card state from a staged / booked package (Cancel restages this).
 *
 * `prevLegCount` is the leg count the card is already showing. A package
 * that is not a strip carries no leg count of its own, and the branches
 * below used to answer a hard 3 — so cancelling an executed strip re-derived
 * a non-strip package and silently reset an approved 5-leg ladder to the
 * default 3. The desk's own number survives unless a strip states otherwise.
 */
export function structCfgFromPrepared(
  prep: PreparedHedgeProfile | undefined,
  tfM: number,
  prevLegCount?: number,
): StructCfg {
  const carried =
    typeof prevLegCount === 'number'
      && Number.isFinite(prevLegCount)
      && prevLegCount >= 2
      ? Math.floor(prevLegCount)
      : 3;
  if (prep?.structure === 'strip' && prep.legs.length >= 2) {
    const total = prep.coverLocalM;
    let prevCum = 0;
    const t = prep.legs.map(l => l.settleMonths ?? l.endMonth);
    const scaled = Math.abs(total) > 1e-9;
    const legNotionals = prep.legs.map(l => {
      const delta = l.tradeNotionalLocalM ?? l.hedgeLocalM - prevCum;
      prevCum = l.hedgeLocalM;
      return delta;
    });
    const sh = legNotionals.map(d =>
      scaled ? +((d / total) * 100).toFixed(1) : 0,
    );
    // Rounding each share to 0.1% on its own drifts the total: six equal
    // legs each read 16.7% and sum to 100.2%, which lit "Σ share off target"
    // and offered Rebalance on a package that was already balanced. Absorb
    // the drift in the last leg, as stripShareWeights and rebalanceShares do.
    //
    // `sh` is not display-only — buildStructuredProfile sizes each leg as
    // target × sh[i] / 100, so this moves a bookable notional. It moves it
    // towards the package it came from: six legs of a 12.12M ladder booked
    // 6 × 2.024040 = 12.144240 before (over-covering by 24,240), and book
    // 5 × 2.024040 + 1.999800 = 12.120000 now, exact. The cost is that a
    // desk-declared equal ladder's last leg is 24,240 lighter than its five
    // siblings; the total matching cover is worth more than six identical
    // legs that do not.
    //
    // Only true float noise is absorbed. An earlier 0.05pp tolerance also
    // swallowed a real shortfall of up to 0.05% of cover — 250,000 on a
    // 500M package — and reported it as balanced.
    const exactTotalPct = scaled
      ? (legNotionals.reduce((a, b) => a + b, 0) / total) * 100
      : 0;
    if (scaled && Math.abs(exactTotalPct - 100) < 1e-6) {
      sh[sh.length - 1] = +(
        100 - sh.slice(0, -1).reduce((a, b) => a + b, 0)
      ).toFixed(1);
    }
    return {
      structure: 'strip',
      legCount: prep.legs.length,
      shaping: 'optimized',
      t,
      sh,
    };
  }
  if (prep?.structure === 'bullet') {
    const settle = prep.settleMonths ?? (tfM > 0 ? tfM : 1);
    return {
      structure: 'bullet',
      legCount: carried,
      shaping: 'equal',
      t: [settle],
      sh: [100],
    };
  }
  const preset = structPreset('strip', carried, 'equal', tfM);
  return {
    structure: 'bullet',
    legCount: carried,
    shaping: 'equal',
    t: preset.t,
    sh: preset.sh,
  };
}

interface HedgingDecisionLayerProps {
  risk: CurrencyRiskRow[];
  embedded?: boolean;
  title?: string;
  hedgeRatios?: Record<string, number>;
  onHedgeRatiosChange?: (ratios: Record<string, number>) => void;
  /** Booked hedge tickets — shared with Live Ladder for VaR recalculation. */
  bookedHedges?: HedgeTicket[];
  onBookedHedgesChange?: (
    next: HedgeTicket[] | ((prev: HedgeTicket[]) => HedgeTicket[]),
  ) => void;
  /** Analytics-prepared packages (not live until Send). */
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  onPreparedByCcyChange?: (
    next:
      | Record<string, PreparedHedgeProfile>
      | ((
          prev: Record<string, PreparedHedgeProfile>,
        ) => Record<string, PreparedHedgeProfile>),
  ) => void;
  /** Entity/group scope for Market data swap-points carry on Prepare. */
  ratesScopeId?: string;
  /** DB-persisted market data per currency (Market data tab uploads). */
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  /** Shared with Analytics — bullet vs rolling strip. */
  hedgeStructure?: ForecastHedgeStructure;
  onHedgeStructureChange?: (s: ForecastHedgeStructure) => void;
  varSetup?: VarSetup;
  onBookHedge?: (ticket: HedgeTicket) => void;
  bookRows?: RowState[];
  forecastProfile?: ForecastProfileState;
  /** Desk-computed funded plan — the funding strip this module books first. */
  fcyComputed?: FcyComputedRow[];
  r_USD?: number;
  sizingBasis?: LiquiditySizingBasis;
  bookingMode?: LiquidityBookingMode;
  forecastMonths?: number;
  onSizingBasisChange?: (v: LiquiditySizingBasis) => void;
  onBookingModeChange?: (v: LiquidityBookingMode) => void;
  /** Sandbox progress task_id matcher fills must write (workspace / 01 / 02 / practice). */
  sandboxTaskId?: string;
}

/**
 * Decision layer — start at delta = 1 (unhedged), add hedge notional,
 * and read per-currency VaR before / after on the consolidated book.
 */
export function HedgingDecisionLayer({
  risk: seedRisk,
  embedded = true,
  title: _moduleTitle = 'Decision layer — Hedging (Δ → VaR)',
  hedgeRatios: controlledRatios,
  onHedgeRatiosChange,
  bookedHedges: controlledBooked,
  onBookedHedgesChange,
  preparedByCcy: controlledPrepared,
  onPreparedByCcyChange,
  ratesScopeId,
  marketRatesByCcy = {},
  hedgeStructure: controlledStructure,
  onHedgeStructureChange,
  varSetup = DEFAULT_VAR_SETUP,
  onBookHedge,
  bookRows,
  forecastProfile = DEFAULT_FORECAST_PROFILE,
  fcyComputed,
  r_USD,
  sizingBasis,
  bookingMode,
  forecastMonths,
  onSizingBasisChange,
  onBookingModeChange,
  sandboxTaskId,
}: HedgingDecisionLayerProps) {
  const risk = useMemo(
    () =>
      overlayRiskFromFxBook(
        seedRisk,
        bookRows,
        varSetup,
        forecastProfile,
      ),
    [seedRisk, bookRows, varSetup, forecastProfile],
  );
  const [localRatios, setLocalRatios] = useState<Record<string, number>>({});
  const [localBooked, setLocalBooked] = useState<HedgeTicket[]>([]);
  const [localPrepared, setLocalPrepared] = useState<
    Record<string, PreparedHedgeProfile>
  >({});
  const [draft, setDraft] = useState<HedgeTicket | null>(null);
  /**
   * Set only when `draft` is editing an EXISTING working order (never for a
   * fresh Book proposal). The original stays in `booked` untouched until the
   * edit is actually confirmed — closing the panel without submitting must
   * leave the order exactly as it was, OCO sibling included.
   */
  const [editingOriginal, setEditingOriginal] = useState<HedgeTicket | null>(null);
  /** True when `draft` was opened just to look — clicking a blotter row,
   * not its explicit Edit button. */
  const [viewOnly, setViewOnly] = useState(false);
  /** Stable while the ticket panel is open — a fill must not remount the pads. */
  const [ticketPanelKey, setTicketPanelKey] = useState<string | null>(null);
  const [overlayOpenedAtMs, setOverlayOpenedAtMs] = useState<number | null>(null);
  const [hedgeTab, setHedgeTab] = useState<'decision' | 'orders' | 'blotter'>(
    'decision',
  );
  const hedgeTabRef = useRef(hedgeTab);
  hedgeTabRef.current = hedgeTab;
  const [chartCcy, setChartCcy] = useState<string | null>(null);
  const [pathSummaryMetrics, setPathSummaryMetrics] =
    useState<HedgePathSummaryMetrics | null>(null);
  const [pathPrepareAction, setPathPrepareAction] =
    useState<HedgePathPrepareAction | null>(null);
  const [pathBasis, setPathBasis] = useState<HedgePathBasisId>('varNeutral');
  /** bullet = one Tf forward; strip = rolling Th windows (when Tf > Th). */
  const [localStructure, setLocalStructure] =
    useState<ForecastHedgeStructure>('bullet');
  const hedgeStructure = controlledStructure ?? localStructure;
  const setHedgeStructure = (s: ForecastHedgeStructure) => {
    if (onHedgeStructureChange) onHedgeStructureChange(s);
    else setLocalStructure(s);
  };
  const ratios = controlledRatios ?? localRatios;
  /**
   * Parent persist can lag a frame behind blotter `setBooked`. Overlay the
   * in-session book so STRUCTURE pending/filled counts move on the same tick.
   */
  const [optimisticBooked, setOptimisticBooked] = useState<HedgeTicket[] | null>(
    null,
  );
  const parentBooked = controlledBooked ?? localBooked;
  const booked = useMemo(
    () => mergeOptimisticHedgeTickets(parentBooked, optimisticBooked),
    [parentBooked, optimisticBooked],
  );
  const bookedRef = useRef(booked);
  bookedRef.current = booked;
  useEffect(() => {
    if (optimisticBooked == null || !controlledBooked) return;
    // Membership must match too — otherwise a parent that still holds
    // cancelled strip rows (or a thinner optimistic cancel) never clears the
    // overlay, and mergeOptimistic used to union the stale side back in.
    if (optimisticBooked.length !== controlledBooked.length) return;
    const parentById = new Map(controlledBooked.map(t => [t.id, t]));
    const caughtUp = optimisticBooked.every(t => {
      const p = parentById.get(t.id);
      if (!p) return false;
      return t.status !== 'booked' || p.status === 'booked';
    });
    if (caughtUp) setOptimisticBooked(null);
  }, [controlledBooked, optimisticBooked]);
  const execBeatNRef = useRef(0);
  const execMonitorKeyRef = useRef('');
  const [execLog, setExecLog] = useState<ExecutionLogEvent[]>([]);
  const ticketLifecycleRef = useRef<Map<string, string> | null>(null);
  const tapeHistoryRef = useRef<Map<string, TapeHistoryPoint[]>>(new Map());
  const [journalRevision, setJournalRevision] = useState(0);
  const journalReadyRef = useRef(false);
  const [matchingHb, setMatchingHb] = useState<MatchingHeartbeatView | null>(null);
  const monitorFeed = useMemo(
    () =>
      dedupeMonitorEvents([
        ...(matchingHb?.monitorEvents ?? []),
        ...execLog,
      ]).slice(0, 200),
    [matchingHb, execLog],
  );
  const serverAliveRef = useRef(false);
  const serverOwnsFillsRef = useRef(false);
  const appliedServerFillsRef = useRef(new Set<string>());
  /**
   * Order ids the MATCHER filled. The lifecycle publisher below must skip
   * these — the runtime already writes its own FILLED monitor/log lines for
   * them — while still publishing fills made on the client path (leg-row
   * click executions), which the matcher never sees.
   */
  const serverFilledIdsRef = useRef(new Set<string>());

  const journalTaskId = sandboxTaskId ?? inferWorkbenchTaskId();

  useEffect(() => {
    let cancelled = false;
    journalReadyRef.current = false;
    void fetchExecutionJournal(journalTaskId).then(journal => {
      if (cancelled) return;
      if (journal) {
        // The journal can hold events from sessions days old; replaying
        // those painted phantom "strip filled" cards for trades that exist
        // nowhere else — not in the book, not in Postgres. Only
        // same-day-ish history may replay into the feed.
        const replayCutoffMs = Date.now() - 12 * 3600_000;
        const recentEvents = (journal.events ?? []).filter(
          event => !(event.atMs > 0) || event.atMs >= replayCutoffMs,
        );
        setExecLog(prev =>
          dedupeMonitorEvents([...recentEvents, ...prev]).slice(0, 500),
        );
        // Spot tape is canonical per currency now ("EUR|spot"); series
        // recorded under the retired per-tenor/strip spot keys
        // ("EUR|spot|1m", "EUR|spot|s0") have no reader and would otherwise
        // be re-uploaded with every journal save forever.
        tapeHistoryRef.current = new Map(
          Object.entries(journal.tapeByCcy).filter(
            ([key]) => !/^[A-Z]{3}\|spot\|/i.test(key),
          ),
        );
        setJournalRevision(revision => revision + 1);
        // Save only after a load that succeeded: a failed load answers null,
        // or the local copy flagged `localFallback` — which seeds the chart
        // but must not start saves that would overwrite the stored feed and
        // tape with it.
        journalReadyRef.current = !journal.localFallback;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [journalTaskId]);

  useEffect(() => {
    if (!journalReadyRef.current) return;
    const timer = window.setTimeout(() => {
      void saveExecutionJournal(
        {
          events: execLog.slice(0, 500),
          tapeByCcy: Object.fromEntries(tapeHistoryRef.current),
        },
        journalTaskId,
      );
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [execLog, journalRevision, journalTaskId]);

  const spotsForMatcher = useMemo(() => {
    const spots: Record<string, SimSpotQuote> = {};
    const workingQuoteKeys = new Set(
      booked
        .filter(t => t.status === 'scheduled')
        .map(t => tapeQuoteKey(t)),
    );
    for (const t of booked) {
      const quoteKey = tapeQuoteKey(t);
      if (workingQuoteKeys.has(quoteKey) && t.status !== 'scheduled') continue;
      if (t.status === 'scheduled') {
        // A working spot ticket (spot leave order, spot TP/SL bracket) is
        // monitored on the shared per-currency spot tape, and that tape
        // follows the REAL market spot — the matcher walks and records it,
        // the order never re-parks it onto its own stamps.
        if (tapeInstrument(t) === 'spot') {
          const liveSpot = resolveMarketRatesForCcy(
            marketRatesByCcy,
            t.ccy,
            ratesScopeId,
          )?.spot;
          if (liveSpot && liveSpot.mid > 0) {
            spots[quoteKey] = liveSpot;
            continue;
          }
          // No live feed this beat. The shared per-currency spot key may be
          // SEEDED from this order's stamped spot, and from nothing else —
          // never from `restingTapeAnchorMid`, which is deliberately the
          // OUTRIGHT convention. A spot-referenced forward leg falling
          // through to that anchor wrote its outright into `CCY|spot`:
          // measured on one EUR session, 148 prints at ~1.1698 and 72 at
          // ~1.1465 landed on a 1.141 spot tape. Both stretches then read
          // as genuine convention changes, and the chart correctly showed
          // only the tape after the last one — the desk saw a morning of
          // recorded spot replaced by the last forty minutes.
          const stampedSpot = t.ipaQuote?.fxSpot;
          if (stampedSpot != null && stampedSpot > 0) {
            const pip = pipSizeOf(stampedSpot);
            spots[quoteKey] = {
              bid: stampedSpot - pip,
              mid: stampedSpot,
              ask: stampedSpot + pip,
            };
          }
          continue;
        }
        let tapeMid = restingTapeAnchorMid(t);
        if (tapeMid == null && t.limitRate != null && t.limitRate > 0) {
          tapeMid = t.limitRate;
        }
        if (tapeMid != null && tapeMid > 0) {
          if (t.bracketRole === 'stopLoss' && t.limitRate != null) {
            tapeMid = parkMidAwayFromStopLimit(
              tapeMid,
              t.limitRate,
              restingOrderHitSide(t) === 'bid',
            );
          }
          const pip = pipSizeOf(tapeMid);
          spots[quoteKey] = { bid: tapeMid - pip, mid: tapeMid, ask: tapeMid + pip };
        }
        continue;
      }
      // A booked spot ticket's stamped anchor is a stale print — the shared
      // spot tape stays on the live feed below, forwards keep their anchor.
      const orderMid =
        tapeInstrument(t) === 'spot' ? null : restingTapeAnchorMid(t);
      if (orderMid != null && orderMid > 0) {
        const pip = pipSizeOf(orderMid);
        spots[quoteKey] = { bid: orderMid - pip, mid: orderMid, ask: orderMid + pip };
        continue;
      }
      if (tapeInstrument(t) !== 'spot') continue;
      const spot = resolveMarketRatesForCcy(
        marketRatesByCcy,
        t.ccy,
        ratesScopeId,
      )?.spot;
      if (spot && spot.mid > 0) {
        spots[quoteKey] = spot;
      }
    }
    return spots;
  }, [booked, marketRatesByCcy, ratesScopeId]);

  /**
   * The server matcher's own recorded tape replaces the browser walk as the
   * chart's source: recent server points overwrite the same time range
   * locally, older (journal-loaded) history ahead of the server window is
   * kept. The journal save effect then writes the SERVER series back to
   * S3/localStorage, so the persisted record and the deciding record agree.
   */
  const ingestServerTape = (hb: MatchingHeartbeatView | null) => {
    const ingestStartMs = performance.now();
    const tape = hb?.tape;
    if (!tape || typeof tape !== 'object') {
      console.log('[tape-ingest-ui] no tape in heartbeat');
      return;
    }
    let changed = false;
    const keyResults: Record<string, { rawPoints: number; validPoints: number; priorPoints: number; totalPoints: number; processingMs: number }> = {};

    for (const [quoteKey, raw] of Object.entries(tape)) {
      const keyStartMs = performance.now();
      if (!Array.isArray(raw)) continue;
      // A malformed point must not nuke this key's whole local history —
      // firstServerT of undefined would filter nothing below and a bad
      // series would replace a good one.
      const points = raw.filter(
        (p): p is SimSpotQuote & { t: number } =>
          Boolean(p)
          && typeof p.t === 'number' && p.t > 0
          && typeof p.mid === 'number' && p.mid > 0
          && typeof p.bid === 'number' && typeof p.ask === 'number',
      );
      if (points.length === 0) continue;
      const firstServerT = points[0]!.t;
      const prior = (tapeHistoryRef.current.get(quoteKey) ?? []).filter(
        point => point.t < firstServerT,
      );
      tapeHistoryRef.current.set(
        quoteKey,
        capTapeHistory(
          [...prior, ...points.map(point => ({ ...point }))],
          Date.now(),
        ),
      );
      keyResults[quoteKey] = {
        rawPoints: raw.length,
        validPoints: points.length,
        priorPoints: prior.length,
        totalPoints: prior.length + points.length,
        processingMs: performance.now() - keyStartMs,
      };
      changed = true;
    }

    const totalIngestMs = performance.now() - ingestStartMs;
    const keySummary = Object.entries(keyResults)
      .map(([k, v]) =>
        `${k}:${v.totalPoints}pts(${v.processingMs.toFixed(1)}ms)`
      )
      .join(' ');

    console.log(
      `[tape-ingest-ui] keys=${Object.keys(tape).length} ` +
      `valid=${Object.keys(keyResults).length} total=${totalIngestMs.toFixed(1)}ms ` +
      `[${keySummary}]`
    );

    // No journalRevision bump here: the poll's setMatchingHb already
    // re-renders (so the panel picks up the new arrays), and bumping on
    // every 2s heartbeat turned the journal save into a continuous full
    // S3/localStorage PUT loop (review M-3). The walk beat's own periodic
    // bump keeps the ~150s save cadence.
    void changed;
  };

  const noteMatcherHeartbeat = (hb: MatchingHeartbeatView | null) => {
    if (!hb) return;
    const live = matchingServerIsLive(hb);
    serverAliveRef.current = live;
    if (live) serverOwnsFillsRef.current = true;
    else if (hb.verdict === 'stopped') serverOwnsFillsRef.current = false;
    ingestServerTape(hb);
  };

  const applyServerFills = (hb: MatchingHeartbeatView | null) => {
    if (!hb?.fills?.length) return;
    const fresh = hb.fills.filter(f => {
      const key = `${f.orderId}:${f.atMs}:${f.outcome}`;
      if (appliedServerFillsRef.current.has(key)) return false;
      appliedServerFillsRef.current.add(key);
      return true;
    });
    if (fresh.length === 0) return;
    const cancel = new Set(fresh.flatMap(f => f.cancelledOrderIds));
    const byId = new Map<string, (typeof fresh)[number]>();
    const byRest = new Map<string, (typeof fresh)[number]>();
    for (const f of fresh) {
      if (f.outcome === 'filled') {
        serverFilledIdsRef.current.add(f.orderId);
        if (f.ticket.id) serverFilledIdsRef.current.add(f.ticket.id);
      }
      const prev = byId.get(f.orderId);
      if (prev?.outcome === 'filled' && f.outcome !== 'filled') continue;
      byId.set(f.orderId, f);
      byRest.set(hedgeRestingKey(f.ticket), f);
    }
    setBooked(prev => {
      let hit = false;
      const next = prev.map(t => {
        // One-cancels-other, server side: a fill's OCO sibling is marked
        // cancelled and KEPT, matching the local beat's own auto-cancel
        // (line ~1811) — "both rows stay on the blotter (PENDING vs
        // CANCELED)". This used to filter the sibling OUT of `booked`
        // entirely, so once the server reported a fill, the cancelled OCO
        // leg stopped existing anywhere: never persisted, never findable by
        // chartTicketsAtEdge, and its chart level simply never drew.
        if (cancel.has(t.id)) {
          hit = true;
          return t.status === 'cancelled' ? t : { ...t, status: 'cancelled' as const };
        }
        // The restKey fallback used to require t.status === 'scheduled'
        // before even trying — if the client's own copy ever drifted off
        // that status for any reason, the fill notice could never catch
        // it, leaving a genuinely filled ticket stuck showing as resting.
        // The status guards right below already stop this from wrongly
        // reverting a correctly-booked ticket, so gating the lookup itself
        // added a way to miss a fill without adding any real protection.
        const f = byId.get(t.id) ?? byRest.get(hedgeRestingKey(t));
        if (!f) return t;
        if (t.status === 'booked' && f.outcome !== 'filled') return t;
        if (t.status === 'booked' && f.ticket.status === 'scheduled') return t;
        hit = true;
        // The server's copy replaces ours wholesale, and hedgeRestingKey
        // carries neither id nor status — so a row the desk dismissed would
        // come straight back on the next heartbeat that still lists it (the
        // fills window is 60 min while appliedServerFills is per-mount).
        // The dismissal is a local decision the server has no opinion on.
        return t.dismissedAtMs != null
          ? { ...f.ticket, dismissedAtMs: t.dismissedAtMs }
          : f.ticket;
      });
      return hit ? next : prev;
    });
  };

  useEffect(() => {
    let cancelled = false;
    void startMatchingProcess().then(hb => {
      if (cancelled || !hb) return;
      noteMatcherHeartbeat(hb);
      setMatchingHb(hb);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void syncMatchingOrders({
      tickets: booked,
      spots: spotsForMatcher,
      taskId: journalTaskId,
      // An open ticket starts its currency's record immediately — a market
      // execution has no order until it fills, so nothing else would ask
      // the server to record the stretch the desk is actually watching.
      watchCcys: draft ? [draft.ccy] : [],
    }).then(hb => {
      if (!hb) return;
      noteMatcherHeartbeat(hb);
      setMatchingHb(hb);
      applyServerFills(hb);
    });
    // booked identity is the working book the Node matcher must hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booked, spotsForMatcher, journalTaskId, draft?.ccy]);

  // Currency of the open ticket, read by the heartbeat poll below without
  // re-subscribing it every time the draft changes.
  const watchCcyRef = useRef<string | null>(null);
  watchCcyRef.current = draft?.ccy ?? null;
  useEffect(() => {
    let timer = 0;
    let delayMs = 2_000;
    const poll = async () => {
      const wantLog =
        hedgeTabRef.current === 'orders'
        && (typeof document === 'undefined' || !document.hidden);
      const [hb, log] = await Promise.all([
        // A ticket open on a currency keeps that currency recording — this
        // 2s poll is the channel that refreshes it (read through a ref so
        // the poll loop is not re-subscribed on every draft change).
        fetchMatchingHeartbeat(
          0,
          watchCcyRef.current ? [watchCcyRef.current] : [],
          journalTaskId,
        ),
        wantLog
          ? fetchExecutionLogEvents(120)
          : Promise.resolve({ events: [], degraded: false }),
      ]);
      if (hb) {
        noteMatcherHeartbeat(hb);
        setMatchingHb(hb);
        applyServerFills(hb);
        delayMs = 2_000;
      } else {
        delayMs = Math.min(delayMs * 2, 16_000);
      }
      if (log.degraded) delayMs = Math.max(delayMs, 30_000);
      const incoming = [
        ...(hb?.monitorEvents ?? []),
        ...log.events,
      ];
      if (incoming.length > 0) {
        setExecLog(prev =>
          dedupeMonitorEvents([...incoming, ...prev]).slice(0, 400),
        );
      }
      timer = window.setTimeout(poll, delayMs);
    };
    timer = window.setTimeout(poll, 400);
    return () => window.clearTimeout(timer);
  }, []);

  /**
   * Persisted-history backstop: whenever a ticket overlay opens, pull the
   * draft's and its strip siblings' recorded tape from Postgres for any key
   * the in-memory map doesn't hold. The live feed only carries a key while
   * an order still works it, and both the runtime's and this map's memory
   * start empty after a restart — without this, reopening a finished
   * booking always seeded a blank chart. Each key is fetched once per
   * mount; DB points merge BEHIND anything fresher already ingested.
   */
  const deepTapeRequestedRef = useRef(new Set<string>());
  /**
   * True while the DB backstop fetch for the CURRENTLY OPEN ticket's own
   * key is in flight. The chart otherwise paints an empty series on first
   * render and pops the recorded history in a moment later once the fetch
   * resolves — a visible "blank then loads" flash on every reopened
   * executed leg. The panel uses this to show an explicit loading state
   * instead, only for a ticket that actually has a level or a fill (a
   * genuinely fresh compose has nothing to wait for).
   */
  const [tapeHistoryLoading, setTapeHistoryLoading] = useState(false);
  useEffect(() => {
    if (!draft) return;
    // Request every spelling a ticket's tape may have been recorded under
    // (tapeQuoteKeyCandidates: canonical months form first, then the
    // retired maturity-label form), and remember which CANONICAL key each
    // spelling belongs to so legacy rows merge into the map entry the
    // chart actually reads — 297 recorded rows once sat under
    // "EUR|forward|9m" while the modal read "EUR|forward|t9.00".
    const canonicalFor = new Map<string, string>();
    const groupTickets: HedgeTicket[] = [draft];
    if (draft.stripId) {
      for (const t of booked) {
        if (t.stripId === draft.stripId) groupTickets.push(t);
      }
    }
    for (const t of groupTickets) {
      const [canonical, ...legacy] = tapeQuoteKeyCandidates(t);
      canonicalFor.set(canonical!, canonical!);
      for (const key of legacy) {
        if (!canonicalFor.has(key)) canonicalFor.set(key, canonical!);
      }
      // A forward leg's persisted record is its currency's SPOT series
      // (forward keys are derived, not stored) — fetch it too.
      const spotKey = `${t.ccy.toUpperCase()}|spot`;
      if (!canonicalFor.has(spotKey)) canonicalFor.set(spotKey, spotKey);
    }
    const keys = new Set(canonicalFor.keys());
    // The booking chart tells the ORDER'S story: from the placement instant
    // (encoded in the ticket id) to a few minutes past the last execution.
    // Scope the DB read to that span — "newest 2000 rows" is the wrong
    // stretch of tape for any fill older than half an hour.
    // Only a PLACED order anchors the story start — the same rule the ticket
    // panel's own storyWindow uses. A reopened draft's id is minted when the
    // modal is composed, so anchoring the DB READ on it asked Postgres for
    // [now, …], got zero rows, and left the chart with a fill marker and no
    // candles. The two windows must agree; the fetch errs wide because the
    // panel clips what it does not need, while rows never fetched are lost.
    const placedTimes = groupTickets
      .filter(
        t =>
          t.status === 'booked'
          || t.status === 'cancelled'
          || (t.status === 'scheduled' && t.limitRate != null),
      )
      .map(t => ticketPlacedAtMs(t.id))
      .filter((n): n is number => n != null);
    const fillTimes = groupTickets
      .map(t => t.filledAtMs)
      .filter((n): n is number => n != null && Number.isFinite(n) && n > 0);
    const allDone = groupTickets.every(
      t => t.status === 'booked' || t.status === 'cancelled',
    );
    const minFill = fillTimes.length > 0 ? Math.min(...fillTimes) : null;
    let fromMs = placedTimes.length > 0 ? Math.min(...placedTimes) : null;
    // A placement cannot postdate a fill: a reopened draft's REGENERATED id
    // decodes to the reopen instant, and windowing the DB read to that
    // returned zero rows — the blank chart. Contradicted decode falls back
    // to a span before the fills.
    if (fromMs != null && minFill != null && fromMs > minFill) {
      fromMs = minFill - 30 * 60_000;
    }
    // The fetch must err WIDE of the panel's window (the panel clips what it
    // does not need; rows never fetched are lost). A market-filled leg's id
    // decodes to its fill instant, so anchoring on it read 3.7 minutes of
    // tape for a story the panel opened 30 minutes before the first fill —
    // the chart drew nothing. Always read at least that lead before it.
    if (minFill != null) {
      const lead = minFill - 30 * 60_000;
      fromMs = fromMs == null ? lead : Math.min(fromMs, lead);
    }
    const toMs =
      allDone && fillTimes.length > 0
        ? Math.max(...fillTimes) + POST_FILL_TAPE_TAIL_MS
        : null;
    // Fetch once per key per mount — NOT only when the in-memory map is
    // empty. While an order still works its key, the heartbeat streams live
    // ticks into the map within seconds of page load, so an "only if empty"
    // gate suppressed the DB read on every reopened modal with working
    // orders: the chart seeded from the seconds of ticks since reload and
    // the recorded history never loaded. The merge below already keeps
    // anything fresher than the DB rows, so fetching alongside live ingest
    // is safe.
    // Remember key AND window. A live execution changes the story: the
    // panel is usually open (fetching [now, …] and getting nothing back)
    // BEFORE the desk clicks, and a key-only memo then refused to read
    // again once the fill defined a real window — so the recorded ticks
    // from before the execution stayed in Postgres and the chart drew
    // only what it had appended live, until a reload. The window settles
    // after at most a couple of transitions (no order → placed → filled),
    // so this re-reads a handful of times, not continuously.
    const readWindow = (
      winFrom: number | null,
      winTo: number | null,
      showsLoading: boolean,
    ) => {
      const windowSig = `${winFrom ?? ''}|${winTo ?? ''}`;
      const missing = [...keys].filter(
        key => !deepTapeRequestedRef.current.has(`${key}@${windowSig}`),
      );
      if (missing.length === 0) return;
      for (const key of missing) {
        deepTapeRequestedRef.current.add(`${key}@${windowSig}`);
      }
      // A failed or empty response must NOT permanently disable the backstop
      // for these keys (audit finding): un-mark them so the next overlay
      // open retries instead of guaranteeing the guard panel forever.
      const releaseKeys = () => {
        for (const key of missing) {
          deepTapeRequestedRef.current.delete(`${key}@${windowSig}`);
        }
      };
      // Deliberately NOT cancelled on re-run. The payload lands in a ref, which
      // is safe to write at any time, and the keys were marked as requested
      // BEFORE the fetch. Aborting mid-flight therefore dropped the rows AND
      // left the keys marked, so the guard above ("already requested") refused
      // to read again for the life of the mount — one poisoning re-run and a
      // reopened booking never loaded its recorded tape at all. `booked`
      // re-identifies whenever the book syncs, so that race was routine, not
      // rare: 1359 recorded EUR|spot rows sat in Postgres inside the story
      // window while the chart drew nothing and fell back to the spot record.
      if (showsLoading) setTapeHistoryLoading(true);
      void (async () => {
        try {
          const params = new URLSearchParams({
            taskId: journalTaskId,
            keys: missing.join(','),
          });
          if (winFrom != null) params.set('fromMs', String(winFrom));
          if (winTo != null) params.set('toMs', String(winTo));
          const res = await fetch(`/api/matching-process/orders?${params}`, {
            cache: 'no-store',
          });
          if (!res.ok) {
            releaseKeys();
            return;
          }
          const body = (await res.json()) as {
            tapeHistory?: Record<string, TapeHistoryPoint[]>;
          };
          if (!body.tapeHistory) {
            releaseKeys();
            return;
          }
          let changed = false;
          for (const [key, raw] of Object.entries(body.tapeHistory)) {
            if (!Array.isArray(raw) || raw.length === 0) continue;
            const points = raw.filter(
              p =>
                Boolean(p)
                && typeof p.t === 'number' && p.t > 0
                && typeof p.mid === 'number' && p.mid > 0
                && typeof p.bid === 'number'
                && typeof p.ask === 'number',
            );
            if (points.length === 0) continue;
            // Legacy-spelling rows land in the CANONICAL entry — the only
            // key the chart reads.
            const mapKey = canonicalFor.get(key) ?? key;
            // Marked as the story's own rows: the live keep window must not
            // evict them, however old the booking they belong to.
            const byTime = new Map<number, TapeHistoryPoint>(
              points.map(p => [p.t, { ...p, recorded: true }]),
            );
            // Anything ingested since the request stays authoritative.
            for (const p of tapeHistoryRef.current.get(mapKey) ?? []) {
              byTime.set(p.t, p);
            }
            tapeHistoryRef.current.set(
              mapKey,
              capTapeHistory(
                [...byTime.values()].sort((a, b) => a.t - b.t),
                Date.now(),
              ),
            );
            changed = true;
          }
          // Nothing came back for this window — usually the read ran before
          // the ticks were recorded. Release so the next attempt retries
          // instead of the key being considered done forever.
          if (!changed) releaseKeys();
          if (changed) setJournalRevision(revision => revision + 1);
        } catch {
          // Backstop only — the live feed still populates the chart; a failed
          // read here degrades to the pre-existing behavior, never breaks it.
          releaseKeys();
        } finally {
          if (showsLoading) setTapeHistoryLoading(false);
        }
      })();
    };
    readWindow(fromMs, toMs, true);
    // And each execution's own moment. The story read above takes the
    // NEWEST rows of its window (loadLegTapeTicks), so while the story is
    // open (no end) a fill hours old falls outside it: the first leg's
    // take-profit filled on a real ask print at 13:07 UTC, 12,000 recorded
    // rows back, and its chart had no candle there — the pin sat on the
    // first bar it did have, which never reached the level.
    for (const fillAt of new Set(fillTimes)) {
      readWindow(fillAt - FILL_TAPE_LEAD_MS, fillAt + POST_FILL_TAPE_TAIL_MS, false);
    }
  }, [draft, booked, journalTaskId]);

  useEffect(() => {
    if (!draft) {
      setTicketPanelKey(null);
      setOverlayOpenedAtMs(null);
      return;
    }
    setTicketPanelKey(k => k ?? `tape:${draft.ocoGroupId ?? draft.id}`);
    // Do not swap the ticket under an in-progress edit.
    if (editingOriginal) return;
    // A free Decision Book compose ticket is not on the blotter yet —
    // never replace it with a previously filled hedge for the same CCY.
    if (isFreeBookComposeTicket(draft)) return;
    const same = booked.find(t => t.id === draft.id);
    if (same) {
      if (same.status !== draft.status || same.filledAtMs !== draft.filledAtMs) {
        setDraft(same);
      }
      return;
    }
    const filled = filledTicketForDraft(booked, draft);
    if (filled) setDraft(filled);
  }, [booked, draft, editingOriginal]);
  /**
   * Side-channel for "the other OCO leg was auto-cancelled" — purely for
   * display. Deliberately NOT part of `booked`/HedgeTicket: that status
   * model is load-bearing for VAR/exposure everywhere else, and this is
   * only ever read by the notice below.
   */
  const ocoCancelCaptureRef = useRef<
    { ccy: string; role?: 'takeProfit' | 'stopLoss'; amountLocalM: number }[]
  >([]);
  /**
   * Tape history per CCY, recorded from the moment its first resting order
   * appears — not from whenever a ticket panel happens to be open — so
   * reopening an order later (Edit, or just to check on it) shows the whole
   * path since it was placed, not just what ticks in while the panel is up.
   * A ref, not state: it's written every beat and only ever READ once, at
   * the instant a ticket panel opens, so it must not drive re-renders.
   */
  const [ocoCancelEvents, setOcoCancelEvents] = useState<
    { id: string; ccy: string; role?: 'takeProfit' | 'stopLoss'; amountLocalM: number; at: number }[]
  >([]);
  const allPrepared = controlledPrepared ?? localPrepared;
  const preparedByCcy = releasedPreparedByCcy(allPrepared);
  const releasedLive = (ccy: string) => livePreparedHedge(preparedByCcy[ccy]);

  /**
   * Book scope for supersede filters. On the consolidated desk `bookedHedges`
   * is the cross-entity aggregate, so anything that removes prior tickets must
   * key on this or it will delete other entities' hedges.
   */
  const bookScopeId = ratesScopeId ?? GROUP_HEDGE_SCOPE;
  const setRatios = (next: Record<string, number>) => {
    if (onHedgeRatiosChange) onHedgeRatiosChange(next);
    else setLocalRatios(next);
  };
  const setBooked = (
    next: HedgeTicket[] | ((prev: HedgeTicket[]) => HedgeTicket[]),
  ) => {
    const apply = (prev: HedgeTicket[]) =>
      collapseDuplicateStripSlots(
        typeof next === 'function' ? next(prev) : next,
      );
    if (onBookedHedgesChange) {
      setOptimisticBooked(prev => apply(prev ?? bookedRef.current));
      onBookedHedgesChange(apply);
    } else {
      setLocalBooked(apply);
    }
  };
  const setPreparedByCcy = (
    next:
      | Record<string, PreparedHedgeProfile>
      | ((
          prev: Record<string, PreparedHedgeProfile>,
        ) => Record<string, PreparedHedgeProfile>),
  ) => {
    if (onPreparedByCcyChange) onPreparedByCcyChange(next);
    else setLocalPrepared(prev => (typeof next === 'function' ? next(prev) : next));
  };

  const TfM =
    typeof varSetup.forecastMonths === 'number' && varSetup.forecastMonths > 0
      ? varSetup.forecastMonths
      : 0;
  // Cash Carry / FX Risk path strips are Tf ladders (Tf ≥ 2). Rolling
  // windows (Tf > Th) are only one way to get a strip — do not hide an
  // already-released Cash Carry schedule when VaR tenor equals forecast.
  const hasReleasedStrip = Object.values(preparedByCcy).some(
    p => isPreparedStrip(livePreparedHedge(p)),
  );
  const stripAvailable =
    TfM >= 2 || needsRollingHedges(varSetup) || hasReleasedStrip;
  const stripBooked = booked.some(t => Boolean(t.stripId));
  const effectiveStructure: ForecastHedgeStructure =
    stripAvailable && (hedgeStructure === 'strip' || stripBooked || hasReleasedStrip)
      ? 'strip'
      : 'bullet';
  /** Bullet sizes VaR at Th = Tf. Path VN uses totalBuildup when Analytics is stock. */
  const hedgeSizingSetup = useMemo(
    () => varSetupForHedgeStructure(varSetup, effectiveStructure),
    [varSetup, effectiveStructure],
  );
  const pathRegimeSetup = useMemo(
    () => varSetupForPathHedgeRegime(varSetup, effectiveStructure),
    [varSetup, effectiveStructure],
  );

  // Rolling-only setups with no released strip stay on bullet.
  useEffect(() => {
    if (stripAvailable) return;
    if (hedgeStructure === 'strip') {
      setHedgeStructure('bullet');
    }
  }, [stripAvailable, hedgeStructure]);

  const monthlyFlowsByCcy = useMemo(() => {
    const out: Record<string, number[]> = {};
    const T = varSetup.forecastMonths;
    if (T <= 0) return out;
    const rowsByCcy = new Map((bookRows ?? []).map(r => [r.ccy, r]));
    for (const { bar } of risk) {
      if (bar.ccy === 'USD') continue;
      const row = rowsByCcy.get(bar.ccy);
      if (!row) continue;
      out[bar.ccy] = monthlyFxFlowSeriesLocalM(row, T, forecastProfile);
    }
    return out;
  }, [bookRows, forecastProfile, risk, varSetup.forecastMonths]);

  const summary = useMemo(
    () =>
      buildHedgeVarSummary(
        risk,
        ratios,
        hedgeSizingSetup,
        booked,
        monthlyFlowsByCcy,
        forecastProfile,
      ),
    [risk, ratios, hedgeSizingSetup, booked, monthlyFlowsByCcy, forecastProfile],
  );

  /**
   * Resting ("leave") orders waiting on the simulated tape. Keyed by CCY so
   * the monitor below only walks currencies that actually have one working.
   */
  const tapeWalkTickets = useMemo(() => {
    const out = new Map<string, HedgeTicket>();
    for (const t of booked) {
      if (t.status === 'scheduled' && t.limitRate != null) {
        out.set(tapeQuoteKey(t), t);
      }
    }
    if (draft) out.set(tapeQuoteKey(draft), draft);
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [booked, draft]);

  /**
   * Background monitor: walks the simulated tape for every CCY with a resting
   * order and executes the ones whose level is reached. Runs here rather than
   * in the ticket modal so it keeps working after the modal closes.
   *
   * A fill REPLACES the scheduled order with a booked ticket carrying a fresh
   * id inside one state update — that makes a double fill structurally
   * impossible (the scheduled row is gone in the same commit) and is also what
   * makes the push feed ring, since it notifies on unseen ids.
   *
   * `limitRate` is deliberately kept on the filled ticket: it is the level that
   * triggered, and `ipaQuote.fxOutright` records what it actually filled at, so
   * the decision stays reconstructible. `restingOrderTriggersAt` short-circuits
   * on `status !== 'scheduled'`, so a filled ticket can never re-trigger.
   */
  const restingSig = tapeWalkTickets.map(([key]) => key).join(',');
  useEffect(() => {
    if (tapeWalkTickets.length === 0) return;
    const anchors = new Map<string, SimSpotQuote>();
    for (const [quoteKey, ticket] of tapeWalkTickets) {
      const spot = resolveMarketRatesForCcy(
        marketRatesByCcy,
        ticket.ccy,
        ratesScopeId,
      )?.spot;
      // Prefer the mid the desk actually saw when it left the order. walkSpot
      // caps the walk near its anchor, so anchoring on a stale curve seed can
      // leave a level permanently out of reach.
      const seenMid = restingTapeAnchorMid(ticket);
      if (seenMid != null && seenMid > 0) {
        const halfSpread = spot && spot.mid > 0
          ? Math.max(pipSizeOf(seenMid), Math.abs(spot.ask - spot.bid) / 2)
          : pipSizeOf(seenMid);
        anchors.set(quoteKey, {
          bid: seenMid - halfSpread,
          mid: seenMid,
          ask: seenMid + halfSpread,
        });
      } else if (
        spot
        && spot.mid > 0
        && tapeInstrument(ticket) === 'spot'
      ) {
        anchors.set(quoteKey, spot);
      }
      // Seed history once, at the order's own anchor — never on a later
      // re-run of this effect (e.g. another CCY's order arriving), so an
      // already-recording CCY's history is never reset out from under it.
      // Not while the server matcher owns the tape: its recorded series
      // arrives via the heartbeat poll and must stay the only source.
      const anchor = anchors.get(quoteKey);
      if (
        anchor
        && !serverOwnsFillsRef.current
        && !tapeHistoryRef.current.has(quoteKey)
      ) {
        tapeHistoryRef.current.set(quoteKey, [{ ...anchor, t: Date.now() }]);
      }
    }
    if (anchors.size === 0) return;
    const walked = new Map<string, SimSpotQuote>(anchors);
    for (const [quoteKey] of tapeWalkTickets) {
      const last = tapeHistoryRef.current.get(quoteKey)?.at(-1);
      if (last) walked.set(quoteKey, { bid: last.bid, mid: last.mid, ask: last.ask });
    }
    let timer = 0;
    const beat = () => {
      const t0 =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      for (const [quoteKey, anchor] of anchors) {
        const cur = walked.get(quoteKey) ?? anchor;
        const { next } = walkSpot(cur, anchor, pipSizeOf(anchor.mid));
        walked.set(quoteKey, next);
        // The chart's history comes from the server's recorded tape while
        // the matcher owns fills — the local walk then only keeps the
        // offline-fallback state, it must not fabricate chart points.
        if (serverOwnsFillsRef.current) continue;
        const hist = tapeHistoryRef.current.get(quoteKey);
        if (hist) {
          const now = Date.now();
          hist.push({ ...next, t: now });
          const kept = capTapeHistory(hist, now);
          if (kept !== hist) tapeHistoryRef.current.set(quoteKey, kept);
        }
      }
      const elapsedMs =
        (typeof performance !== 'undefined' ? performance.now() : Date.now())
        - t0;
      execBeatNRef.current += 1;
      if (execBeatNRef.current % 30 === 0) {
        setJournalRevision(revision => revision + 1);
      }
      // Node matcher owns fills once it has been live — a compile blip must
      // not let the browser book a second copy of the same rest.
      if (serverOwnsFillsRef.current) {
        timer = window.setTimeout(beat, RESTING_ORDER_POLL_MS);
        return;
      }
      const heartbeat = execBeatNRef.current % EXEC_HEARTBEAT_BEATS === 0;
      const decisions = explainWorkingOrders(bookedRef.current, walked);
      const execEvents = eventsForBeat(
        decisions,
        elapsedMs,
        walked.size,
        heartbeat,
        Date.now(),
        execMonitorKeyRef.current,
      );
      execMonitorKeyRef.current = monitorSnapshotKey(decisions);
      if (execEvents.length > 0) {
        setExecLog(prev => [...execEvents, ...prev].slice(0, 400));
        publishExecutionLogs(execEvents);
      }
      const hasTriggeredOrder = bookedRef.current.some(ticket => {
        const quote = walked.get(tapeQuoteKey(ticket));
        return Boolean(
          ticket.status === 'scheduled'
          && quote
          && restingOrderTriggersAt(ticket, quote),
        );
      });
      if (!hasTriggeredOrder) {
        timer = window.setTimeout(beat, RESTING_ORDER_POLL_MS);
        return;
      }
      setBooked(prev => {
        let hit = false;
        /** OCO groups whose leg filled on THIS beat — only these cancel. */
        const filledGroups = new Set<string>();
        // The automated cap is on the POSITION, not one ticket: seed it with
        // live cover already on the book per CCY, then add each fill as it is
        // allowed, so orders cannot be split under the limit.
        const committedUsdM = new Map<string, number>();
        for (const t of prev) {
          if (!isLiveHedgeTicket(t) || t.stripId) continue;
          const q = walked.get(tapeQuoteKey(t));
          if (!q) continue;
          committedUsdM.set(
            t.ccy,
            (committedUsdM.get(t.ccy) ?? 0)
              + ticketNotionalUsdM(t, usdPerLocalFromQuote(t.ccy, q.mid)),
          );
        }
        const next = prev.map((t): HedgeTicket => {
          const quote = walked.get(tapeQuoteKey(t));
          if (!quote || !restingOrderTriggersAt(t, quote)) return t;
          // Automated execution is capped by policy — above the cap the order
          // stays working and must not book without FX Lead + CFO. The rate is
          // the one it would fill at, not a fixture pin.
          const usdPerLocal = usdPerLocalFromQuote(t.ccy, quote.mid);
          if (
            !autoFillAllowedByPolicy(
              t,
              usdPerLocal,
              committedUsdM.get(t.ccy) ?? 0,
            )
          ) {
            // Hard stop: books nothing. Flag it once so the desk is told.
            // Status stays scheduled so nothing is committed. Keep the same
            // id so the Node matcher can consume this working key.
            if (t.ipaQuote?.errorMessage === OVER_AUTOMATED_LIMIT_NOTE) return t;
            hit = true;
            return {
              ...t,
              ipaQuote: {
                ...(t.ipaQuote ?? EMPTY_IPA_QUOTE),
                errorMessage: OVER_AUTOMATED_LIMIT_NOTE,
              },
            };
          }
          committedUsdM.set(
            t.ccy,
            (committedUsdM.get(t.ccy) ?? 0) + ticketNotionalUsdM(t, usdPerLocal),
          );
          hit = true;
          if (t.ocoGroupId) filledGroups.add(t.ocoGroupId);
          // The recorded fill price must be the SAME side that decided the
          // trigger — restingOrderTriggersAt never reads orderHit (a UI-tile
          // concept, not a market side), so neither does this.
          const fillPx =
            restingOrderHitSide(t) === 'bid' ? quote.bid : quote.ask;
          return {
            ...t,
            status: 'booked' as const,
            filledAtMs: Date.now(),
            // Record the dealer at fill time — executed-side bank of the
            // tile rotation — so the blotter carries the same name the fill
            // footer shows (review finding 11).
            counterparty: fillCounterpartyFor({
              ccy: t.ccy,
              stripEdgeIndex: t.stripEdgeIndex,
              counterparty: t.counterparty,
              executedHit: restingOrderHitSide(t),
            }),
            // Deliberately does NOT touch orderHit — same reason as above. It
            // is the tile the level was typed into, and a fill does not move
            // the order to a different tile.
            ipaQuote: quoteAfterFill(
              t.ipaQuote,
              spotReferencedFillQuote(t, fillPx) ?? {
                fxOutright: fillPx,
                fxSpot: quote.mid,
              },
            ),
          };
        });
        if (!hit) return prev;
        // One-cancels-other: a leg that filled on this beat marks its
        // still-working siblings cancelled in the same commit so both rows
        // stay on the blotter (PENDING vs CANCELED) and neither stays live.
        if (filledGroups.size === 0) return next;
        const isCancelledSibling = (t: HedgeTicket) =>
          t.status === 'scheduled'
          && t.ocoGroupId != null
          && filledGroups.has(t.ocoGroupId);
        ocoCancelCaptureRef.current = next
          .filter(isCancelledSibling)
          .map(t => ({ ccy: t.ccy, role: t.bracketRole, amountLocalM: t.amountLocalM }));
        return next.map(t =>
          isCancelledSibling(t)
            ? { ...t, status: 'cancelled' as const }
            : t,
        );
      });
      if (ocoCancelCaptureRef.current.length > 0) {
        const captured = ocoCancelCaptureRef.current;
        ocoCancelCaptureRef.current = [];
        setOcoCancelEvents(prevEvents =>
          [
            ...captured.map(c => ({ ...c, id: newHedgeTicketId(), at: Date.now() })),
            ...prevEvents,
          ].slice(0, 10),
        );
      }
      timer = window.setTimeout(beat, RESTING_ORDER_POLL_MS);
    };
    timer = window.setTimeout(beat, RESTING_ORDER_POLL_MS);
    return () => window.clearTimeout(timer);
    // `booked` is read through setBooked's updater, so the loop must not
    // restart on every fill — it keys on which CCYs are resting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restingSig, marketRatesByCcy, ratesScopeId]);

  /** Re-snap Cash·VN·Target % and rebuild strips when Analytics setup changes. */
  const hedgeSetupSig = [
    varSetup.exposureBasis,
    varSetup.averagingConvention,
    varSetup.forecastMonths,
    varSetup.horizon,
    varSetup.confidencePct,
    varSetup.forecastUncertainty1m,
    JSON.stringify(forecastProfile.uncertainty1mByCcy ?? {}),
    // Effective σ₁ₘ, not just the source id — an edited override changes the
    // vol without changing which source is selected.
    monthlyVolForSetup(varSetup),
    hedgeSizingSetup.horizon,
    hedgeSizingSetup.exposureBasis,
  ].join('|');
  const prevHedgeSetupSig = useRef<string | null>(null);
  useEffect(() => {
    if (prevHedgeSetupSig.current === null) {
      prevHedgeSetupSig.current = hedgeSetupSig;
      return;
    }
    if (prevHedgeSetupSig.current === hedgeSetupSig) return;
    prevHedgeSetupSig.current = hedgeSetupSig;
    const mixLocked = Object.values(preparedByCcy).some(
      p => p.preparedFor === 'var',
    );
    if (!mixLocked) {
      const synced = resyncHedgeRatiosToNearestRegime(summary.rows, ratios);
      if (synced) setRatios(synced);
    }
    // FX Risk mix: booked tickets stay; pending = w×E − booked.
    if (!mixLocked) {
      const bars = risk.map(r => ({
        ccy: r.bar.ccy,
        stockNetM: r.bar.stockNetM,
        flowM: r.bar.flowM,
      }));
      const rebuilt = resyncBookedRollingStrips(
        booked,
        bars,
        varSetup,
        monthlyFlowsByCcy,
      );
      if (rebuilt) setBooked(rebuilt);
    }
  }, [hedgeSetupSig, summary.rows, ratios, booked, risk, varSetup, monthlyFlowsByCcy, preparedByCcy]);

  const prevSizerRef = useRef<HedgeSizerSnapshot>({});
  const prevSizerSigRef = useRef<string | null>(null);
  const currentSizer = useMemo((): HedgeSizerSnapshot => {
    const stockBy = new Map(risk.map(r => [r.bar.ccy, r.bar.stockNetM]));
    const out: HedgeSizerSnapshot = {};
    for (const r of summary.rows) {
      out[r.ccy] = {
        forecast: mixCoverTargetLocalM(r),
        stock: stockBy.get(r.ccy) ?? r.stockHedgeLocalM,
        varNeutral: r.equalVarHedgeLocalM,
        booked: r.bookedCoverLocalM ?? bookedNotionalLocalM(booked, r.ccy),
      };
    }
    return out;
  }, [risk, summary.rows, booked]);
  const currentSizerSig = useMemo(
    () =>
      Object.keys(currentSizer)
        .sort()
        .map(ccy => {
          const s = currentSizer[ccy];
          if (!s) return ccy;
          return `${ccy}:${s.forecast.toFixed(6)}:${s.stock.toFixed(6)}:${s.varNeutral.toFixed(6)}:${(s.booked ?? 0).toFixed(6)}`;
        })
        .join('|'),
    [currentSizer],
  );
  useEffect(() => {
    if (prevSizerSigRef.current === null) {
      prevSizerRef.current = currentSizer;
      prevSizerSigRef.current = currentSizerSig;
      return;
    }
    if (prevSizerSigRef.current === currentSizerSig) return;
    const from = prevSizerRef.current;
    prevSizerRef.current = currentSizer;
    prevSizerSigRef.current = currentSizerSig;
    setPreparedByCcy(prepared => {
      const next = scalePreparedHedgesBySizerMove(
        prepared,
        from,
        currentSizer,
      );
      return next ?? prepared;
    });
  }, [currentSizer, currentSizerSig]);

  const riskByCcy = useMemo(() => {
    const m = new Map<string, CurrencyRiskRow>();
    for (const r of risk) m.set(r.bar.ccy, r);
    return m;
  }, [risk]);

  const stagedCarryByCcyUsdM = useMemo(
    () => stagedFxHedgeCarryByCcyUsdM(preparedByCcy),
    [preparedByCcy],
  );
  const stagedCarryUsdMTotal = useMemo(
    () => Object.values(stagedCarryByCcyUsdM).reduce((s, v) => s + v, 0),
    [stagedCarryByCcyUsdM],
  );

  const setRatio = (ccy: string, pct: number) => {
    // Manual: 0–100% of Total expected (Target).
    setRatios({
      ...ratios,
      [ccy]: clampPct(pct) / 100,
    });
  };

  const hedgeAll = (pct: number) => {
    const next: Record<string, number> = {};
    for (const r of summary.rows) next[r.ccy] = clampPct(pct) / 100;
    setRatios(next);
  };

  const openPathChart = (ccy: string) => {
    const r = summary.rows.find(row => row.ccy === ccy);
    if (!r) return;
    const prep = releasedLive(ccy);
    if (isPreparedStrip(prep)) {
      setHedgeStructure('strip');
    } else if (prep?.structure === 'bullet') {
      setHedgeStructure('bullet');
    }
    const inferred =
      prep?.basis
        ?? (Math.abs(r.hedgeNotionalLocalM) > 1e-9
          ? inferHedgePathBasis(
              r.hedgeNotionalLocalM,
              r.stockHedgeLocalM,
              r.targetHedgeLocalM,
              r.equalVarHedgeLocalM,
            )
          : 'varNeutral');
    setPathBasis(inferred);
    setChartCcy(ccy);
  };

  const closePathChart = () => {
    setChartCcy(null);
    setPathPrepareAction(null);
    setPathSummaryMetrics(null);
  };

  const chartRow = chartCcy
    ? summary.rows.find(r => r.ccy === chartCcy)
    : undefined;
  const chartBar = chartCcy
    ? risk.find(r => r.bar.ccy === chartCcy)?.bar
    : undefined;

  const applyPathBasis = (
    basis: HedgePathBasisId,
    structure?: ForecastHedgeStructure,
  ) => {
    if (!chartRow || !chartBar) return;
    setPathBasis(basis);
    const flowM =
      varSetup.forecastMonths > 0 && Math.abs(chartBar.flowM) > 1e-15
        ? chartBar.flowM
        : 0;
    const flowsForCcy = monthlyFlowsByCcy[chartRow.ccy];
    const { startM, endM, flows } = resolveChartMonthlyFlows(
      chartBar.stockNetM,
      flowM,
      varSetup,
      flowsForCcy,
    );
    // Prefer structure from the chart (avoids stale parent 'bullet' on Strip click).
    if (structure && structure !== hedgeStructure) {
      setHedgeStructure(structure);
    }
    // Never auto-book strips from path chips — only Decision %. Prepare/Send is explicit.
    if (hasRollingStripForCcy(booked, chartRow.ccy)) {
      setBooked(prev => clearRollingStripForCcy(prev, chartRow.ccy));
    }
    const bulletEq = equalVarLinearHedgeNotionalLocalM(
      chartBar.stockNetM,
      flowM,
      chartRow.ccy,
      varSetupForPathHedgeRegime(varSetup, 'bullet'),
      undefined,
      flowsForCcy ?? flows,
    ).amountLocalM;
    const target = hedgeBasisNotionalLocalM(
      basis,
      startM,
      endM,
      bulletEq,
    );
    const target100 = Math.abs(mixCoverTargetLocalM(chartRow));
    const ratio =
      target100 < 1e-12
        ? 0
        : Math.min(1, hedgeRatioForNumber(target, mixCoverTargetLocalM(chartRow)));
    setRatios({ ...ratios, [chartRow.ccy]: ratio });
  };

  const ticketBasisForPath = (
    basis: HedgePathBasisId,
  ): VarExposureBasis =>
    basis === 'cash'
      ? 'stock'
      : basis === 'totalExpected'
        ? 'totalBuildup'
        : varSetup.exposureBasis === 'stock'
          ? 'simpleAvg'
          : varSetup.exposureBasis;

  /** Path-chart Book → stage package under CCY (Send in Decision books it). */
  const bookHedgeProfileFromChart = (args: {
    structure: ForecastHedgeStructure;
    basis: HedgePathBasisId;
    edges: RollingHedgeEdge[];
    cashSettleByEdgeIndex?: Record<number, number>;
    bulletSettleMonths?: number;
    cashDeliveryAt?: 'periodEnd' | 'periodStart' | 'matchExposure';
    coverPct?: number;
  }) => {
    if (!chartRow || !chartBar) return;
    const {
      structure,
      basis,
      edges,
      cashSettleByEdgeIndex,
      bulletSettleMonths: chartBulletSettle,
      cashDeliveryAt,
      coverPct: coverPctArg,
    } = args;
    const coverPct = Math.min(1, Math.max(0, coverPctArg ?? 1));
    setPathBasis(basis);
    setHedgeStructure(structure);
    const ticketBasis = ticketBasisForPath(basis);
    const defaultTf =
      varSetup.forecastMonths || horizonMonths(varSetup.horizon);

    if (structure === 'strip' && edges.length > 1) {
      const coverLocalM = edges[edges.length - 1]?.hedgeLocalM ?? 0;
      const profile = assignImpliedCarryFromSwapPoints(
        {
          structure: 'strip',
          basis,
          ticketBasis,
          legs: edges.map(e => ({
            index: e.index,
            startMonth: e.startMonth,
            endMonth: e.endMonth,
            settleMonths: cashSettleByEdgeIndex?.[e.index] ?? e.endMonth,
            hedgeLocalM: e.hedgeLocalM,
            label: e.label,
            stockStartM: e.stockStartM,
            endExposureM: e.endExposureM,
          })),
          coverLocalM,
          hedgeRatio: coverPct,
          cashDeliveryAt,
        },
        {
          marketRates: resolveMarketRatesForCcy(
            marketRatesByCcy,
            chartRow.ccy,
            ratesScopeId,
          ),
          bulletSettleMonths: defaultTf,
          ccy: chartRow.ccy,
          bookRows,
          forecastProfile,
          forecastMonths: varSetup.forecastMonths,
        },
      );
      setPreparedByCcy(prev =>
        setPreparedHedgeForCcy(prev, chartRow.ccy, {
          ...profile,
          preparedFor: 'var',
          approvalStatus: 'approved',
        }),
      );
      // Stay open — Stage keeps the modal up with a live "Staged" badge.
      // The header shows confirmation; Reset clears the package.
      return;
    }

    // Bullet: stage one forward package; Decision % preview still via Apply chips.
    const flowM =
      varSetup.forecastMonths > 0 && Math.abs(chartBar.flowM) > 1e-15
        ? chartBar.flowM
        : 0;
    const flowsForCcy = monthlyFlowsByCcy[chartRow.ccy];
    const { startM, endM, flows } = resolveChartMonthlyFlows(
      chartBar.stockNetM,
      flowM,
      varSetup,
      flowsForCcy,
    );
    const bulletEq = equalVarLinearHedgeNotionalLocalM(
      chartBar.stockNetM,
      flowM,
      chartRow.ccy,
      varSetupForPathHedgeRegime(varSetup, 'bullet'),
      undefined,
      flowsForCcy ?? flows,
    ).amountLocalM;
    const fullTarget = hedgeBasisNotionalLocalM(basis, startM, endM, bulletEq);
    // This path (chart Book) computed the raw target with no regard for what
    // is already booked — unlike commitStructured's ratio flow, it would
    // happily propose the FULL amount again on top of a live position or a
    // still-working resting order. Net both out the same way, or a second
    // chart-driven Book stacks a duplicate on the same exposure.
    const target = hedgeCoverSnapshot(
      booked,
      chartRow.ccy,
      fullTarget,
      coverPct,
    ).trade;
    if (Math.abs(target) < 1e-9) {
      setPreparedByCcy(prev => clearPreparedHedgeForCcy(prev, chartRow.ccy));
      return;
    }
    const target100 = Math.abs(mixCoverTargetLocalM(chartRow));
    const ratio =
      target100 < 1e-12
        ? 0
        : Math.min(1, hedgeRatioForNumber(target, mixCoverTargetLocalM(chartRow)));
    const bulletSettleMonths = chartBulletSettle ?? defaultTf;
    const profile = assignImpliedCarryFromSwapPoints(
      {
        structure: 'bullet',
        basis,
        ticketBasis,
        legs: [],
        coverLocalM: target,
        hedgeRatio: coverPctArg != null ? coverPct : ratio,
        cashDeliveryAt,
        settleMonths: bulletSettleMonths,
      },
      {
        marketRates: resolveMarketRatesForCcy(
          marketRatesByCcy,
          chartRow.ccy,
          ratesScopeId,
        ),
        bulletSettleMonths,
        ccy: chartRow.ccy,
        bookRows,
        forecastProfile,
        forecastMonths: varSetup.forecastMonths,
      },
    );
    setPreparedByCcy(prev =>
      setPreparedHedgeForCcy(prev, chartRow.ccy, {
        ...profile,
        preparedFor: 'var',
        approvalStatus: 'approved',
      }),
    );
    // Stay open — Stage keeps the modal up with a live "Staged" badge.
  };

  const discardPrepared = (ccy: string) => {
    setPreparedByCcy(prev => clearPreparedHedgeForCcy(prev, ccy));
    // Dropping the package alone leaves structCfg holding the old structure,
    // leg count and shaping — and structureFor reads structCfg BEFORE the
    // (now deleted) package. So the card stayed on Strip and immediately
    // rebuilt a preview ladder of the same size: Reset cleared the package
    // and looked like it had done nothing. Removing the entry falls through
    // to 'bullet'.
    setStructCfg(prev => {
      if (!prev[ccy]) return prev;
      const next = { ...prev };
      delete next[ccy];
      return next;
    });
  };

  /**
   * The trade ticket reshaped this CCY's strip (leg added/removed, settle
   * moved). Save it onto the staged package so this screen renders the same
   * ladder — the ticket panel's own leg state is local and dies with the
   * modal, which is why an added leg used to vanish on close. Regime and
   * approval are carried over so a package already released to this screen
   * stays visible; reshaping with nothing staged lands as approved, since the
   * desk built that ladder here deliberately.
   */
  const saveStripShapeFromTicket = (
    ccy: string,
    pkg: PreparedHedgeProfile,
  ) => {
    if (pkg.structure !== 'strip' || pkg.legs.length < 1) return;
    const staged = allPrepared[ccy];
    setPreparedByCcy(prev =>
      setPreparedHedgeForCcy(prev, ccy, {
        ...pkg,
        basis: staged?.basis ?? pkg.basis,
        ticketBasis: staged?.ticketBasis ?? pkg.ticketBasis,
        hedgeRatio: staged?.hedgeRatio ?? pkg.hedgeRatio,
        preparedFor: staged?.preparedFor ?? 'var',
        approvalStatus: staged?.approvalStatus ?? 'approved',
      }),
    );
    // The card's own legs / shaping / settle controls read structCfg, not the
    // package — leaving them stale means the next click there rebuilds the
    // pre-edit ladder over the top of what was just saved.
    setStructCfg(p => ({
      ...p,
      [ccy]: structCfgFromPrepared(pkg, TfM, p[ccy]?.legCount),
    }));
  };

  /** Commit Analytics-prepared package onto the live Decision book. */
  const sendPreparedToDecision = (
    ccy: string,
    override?: PreparedHedgeProfile,
  ): HedgeTicket[] | undefined => {
    const prep = override ?? releasedLive(ccy);
    const row = summary.rows.find(r => r.ccy === ccy);
    const riskRow = riskByCcy.get(ccy);
    if (!prep || !row || !riskRow) return undefined;

    const E = mixCoverTargetLocalM(row);
    const B = committedHedgeNotionalLocalM(booked, ccy);
    const w = prep.hedgeRatio > 1e-9 ? prep.hedgeRatio : 1;
    const snap = hedgeCoverSnapshot(booked, ccy, E, w);
    const clip = snap.trade;
    if (Math.abs(clip) < 1e-9) return undefined;
    const isUnwind = snap.unwind > 1e-9;
    const ticketPkg = isUnwind
      ? {
          ...prep,
          structure: 'bullet' as const,
          legs: [],
          coverLocalM: clip,
        }
      : Math.abs(prep.coverLocalM - clip) > 1e-6
        ? scalePreparedHedgeToCover(prep, { coverLocalM: clip })
        : prep;
    const addBesideLive =
      isUnwind
      || (Math.abs(B) > 1e-9 && Math.abs(clip - w * E) > 1e-6);

    if (ticketPkg.structure === 'strip' && ticketPkg.legs.length > 1) {
      const edges: RollingHedgeEdge[] = ticketPkg.legs.map(l => ({
        index: l.index,
        startMonth: l.startMonth,
        endMonth: l.endMonth,
        hedgeLocalM: l.hedgeLocalM,
        label: l.label,
        stockStartM: l.stockStartM ?? 0,
        endExposureM: l.endExposureM ?? 0,
      }));
      const settleMonthsByEdgeIndex: Record<number, number> = {};
      for (const l of ticketPkg.legs) {
        settleMonthsByEdgeIndex[l.index] = l.settleMonths ?? l.endMonth;
      }
      const tickets = stampSourcePackage(
        proposeRollingHedgeTickets(
          ccy,
          edges,
          varSetup,
          ticketPkg.ticketBasis,
          monthlyFlowsByCcy[ccy] ?? [],
          settleMonthsByEdgeIndex,
        ),
        ticketPkg,
      );
      setBooked(prev => {
        const hasStrip = prev.some(
          t => t.ccy === ccy && t.stripId && t.status !== 'cancelled',
        );
        if (hasStrip) {
          return mergeStripTicketsIntoBook(prev, tickets);
        }
        return addBesideLive
          ? mergeStripTicketsIntoBook(prev, tickets)
          : mergeRollingStripIntoBook(prev, tickets, ccy);
      });
      setRatios({ ...ratios, [ccy]: 0 });
      for (const t of tickets) {
        if (isLiveHedgeTicket(t)) onBookHedge?.(t);
      }
      setPreparedByCcy(prev => clearPreparedHedgeForCcy(prev, ccy));
      return tickets;
    }

    // Bullet → one forward ticket at cash-delivery settle (default Tf).
    const template = proposeBookHedge(riskRow, ticketPkg.ticketBasis, varSetup);
    const settleM =
      ticketPkg.settleMonths != null
        ? ticketPkg.settleMonths
        : varSetup.forecastMonths > 0
          ? varSetup.forecastMonths
          : horizonMonths(varSetup.horizon);
    const maturity = bulletMaturityForForecast(settleM, varSetup.horizon);
    const maturityLabel =
      VAR_HORIZON_OPTIONS.find(h => h.id === maturity)?.label ?? maturity;
    const settleTag =
      ticketPkg.cashDeliveryAt === 'periodStart'
        ? 'period start'
        : ticketPkg.cashDeliveryAt === 'matchExposure'
          ? 'e ∩ H'
          : 'Tf';
    const ticket: HedgeTicket = {
      ...template,
      id: newHedgeTicketId(),
      instrument: 'forward',
      // This goes straight onto the book as live cover, so it is booked —
      // say so. Leaving `status` unset produced tickets that every fill path
      // stamps but this one did not, and `isMarketExecutedHedgeTicket`
      // requires `status === 'booked'`: such a ticket is invisible to peer
      // matching, to the executed-leg checks, and to strip completion, while
      // the blotter still shows it FILLED. One was found on the live EUR
      // book reading "LIMIT · BUY EUR · €0.02M".
      status: 'booked',
      amountLocalM: clip,
      maturity,
      maturityLabel: `${maturityLabel} · bullet ${settleTag}`,
      varUsdM: computeParametricVarUsdM(clip, ccy, {
        ...varSetup,
        horizon: maturity,
      }),
      sourcePackage: ticketPkg,
    };
    setBooked(prev => {
      if (addBesideLive) return [ticket, ...prev];
      const withoutStrip = hasRollingStripForCcy(prev, ccy)
        ? clearRollingStripForCcy(prev, ccy)
        : prev;
      return [
        ticket,
        ...clearLiveBulletForCcy(withoutStrip, ccy, bookScopeId, ticket.instrument),
      ];
    });
    setRatios({ ...ratios, [ccy]: 0 });
    onBookHedge?.(ticket);
    setPreparedByCcy(prev => clearPreparedHedgeForCcy(prev, ccy));
    return [ticket];
  };

  const openBookModal = (ccy: string) => {
    const row = riskByCcy.get(ccy);
    if (!row) return;
    // Book the Decision Hedge N (Target × %), or the staged package cover.
    const net = summary.rows.find(r => r.ccy === ccy);
    if (!net) return;
    const E = mixCoverTargetLocalM(net);
    const prep = releasedLive(ccy);
    const ratio = ratios[ccy] ?? 0;
    const bookRatio = ratio > 1e-9 ? ratio : 1;
    const snap = hedgeCoverSnapshot(
      booked,
      ccy,
      E,
      prep && prep.hedgeRatio > 1e-9 ? prep.hedgeRatio : bookRatio,
    );
    const amountLocalM = snap.trade;
    if (Math.abs(amountLocalM) < 1e-9) return;
    const isUnwind = snap.unwind > 1e-9;
    const liveStripOnBook = hasRollingStripForCcy(booked, ccy);
    // The new ticket's shape is the card's own selection, full stop. Neither
    // a live strip nor an overhedge overrides it: both used to, and between
    // them the desk could not book a ladder at all — Book silently composed
    // a bullet with no legs while the card's table showed the ladder it had
    // just configured. The card is where structure is chosen; if a buy-back
    // should be a single clip, the desk picks Bullet there.
    const openAs: ForecastHedgeStructure = structureFor(ccy);
    // The card's own draft ladder is what Book opens. `structCfg[ccy]` is
    // written by the Legs / Settle / Share steppers, so it is the desk's
    // most recent intent; the staged package can be older than that (Stage
    // is a separate click, and sending a strip clears it entirely). Reading
    // `prep` first meant stepper edits never reached the modal — the single
    // biggest reason a configured leg count did not survive to Book.
    //
    // This is the ONLY channel for that number: the composed ticket carries
    // a fresh stripId, so the panel's preparedForTicketFromCard short-circuits
    // and never rebuilds from structCfg itself.
    const cardCfg = structCfg[ccy];
    const cardDraft =
      openAs === 'strip'
      && cardCfg?.structure === 'strip'
      && cardCfg.t.length >= 2
        ? buildStructuredProfile(
            ccy,
            amountLocalM,
            'strip',
            cardCfg,
            allPrepared[ccy]?.basis ?? pathBasis,
          )
        : null;
    const preparedForBook = cardDraft ?? prep;
    const template = proposeBookHedge(row, varSetup.exposureBasis, varSetup);
    const bulletSettle = packageForStructure(prep, 'bullet')?.settleMonths;
    // Bullet: Cash Carry settle when staged; else one forward covering Tf.
    const useBulletTenor =
      openAs === 'bullet' || hedgeStructure !== 'strip' || !needsRollingHedges(varSetup);
    const maturity = useBulletTenor
      ? bulletMaturityForForecast(
          bulletSettle ?? varSetup.forecastMonths,
          varSetup.horizon,
        )
      : varSetup.horizon;
    const maturityLabel =
      VAR_HORIZON_OPTIONS.find(h => h.id === maturity)?.label ?? maturity;
    const ticket = composeDecisionBookTicket({
      template,
      amountLocalM,
      isUnwind,
      liveStripOnBook,
      prepared: preparedForBook,
      structure: openAs,
      instrument: 'forward',
      maturity,
      maturityLabel: useBulletTenor
        ? `${maturityLabel} · bullet Tf`
        : maturityLabel,
      varUsdM: computeParametricVarUsdM(amountLocalM, ccy, {
        ...varSetup,
        horizon: maturity,
      }),
    });
    if (Math.abs(ticket.amountLocalM) < 1e-9) return;
    setEditingOriginal(null);
    setViewOnly(false);
    setOverlayOpenedAtMs(Date.now());
    setTicketPanelKey(retainTicketOverlayKey(null, ticket.id, 'book'));
    setDraft(ticket);
  };

  const confirmBook = (
    edited: HedgeTicket,
    choice?: {
      structure?: 'bullet' | 'strip';
      package?: PreparedHedgeProfile;
      fillScope?: 'main' | 'leg' | 'strip';
      stripFills?: readonly { edgeIndex: number; rate: number | null }[];
      stripTickets?: readonly HedgeTicket[];
    },
  ) => {
    const staged = preparedByCcy[edited.ccy];
    const fillScope = choice?.fillScope ?? 'main';
    const overlayStripTickets = (choice?.stripTickets ?? []).filter(
      t => t.status === 'booked' && (t.filledAtMs ?? 0) > 0,
    );
    if (overlayStripTickets.length > 0) {
      setBooked(prev => mergeStripTicketsIntoBook(prev, overlayStripTickets));
      setTicketPanelKey(prev =>
        retainTicketOverlayKey(prev, edited.ocoGroupId ?? edited.id, 'keep'),
      );
      for (const t of overlayStripTickets) onBookHedge?.(t);
      return;
    }
    const want =
      choice?.structure ??
      (staged?.structure === 'strip' && staged.legs.length > 1
        ? 'strip'
        : 'bullet');
    const pkg = choice?.package ?? packageForStructure(staged, want);
    if (fillScope !== 'leg' && want === 'strip' && pkg && pkg.legs.length > 1) {
      const tickets = sendPreparedToDecision(edited.ccy, pkg);
      if (tickets && tickets.length > 0) {
        const stamped = stampLiveFillOnStripTickets(
          tickets,
          edited,
          choice?.stripFills,
        );
        setBooked(prev => mergeStripTicketsIntoBook(prev, stamped));
        const primary =
          stamped.find(t => (t.stripEdgeIndex ?? 0) === 0) ?? stamped[0]!;
        setEditingOriginal(null);
        setDraft(primary);
        setTicketPanelKey(prev =>
          retainTicketOverlayKey(prev, primary.ocoGroupId ?? primary.id, 'keep'),
        );
        setViewOnly(true);
      }
      return;
    }
    const isStandaloneOption = edited.instrument === 'option';
    const ticket: HedgeTicket = {
      ...edited,
      id: newHedgeTicketId(),
      status: 'booked',
      filledAtMs: edited.filledAtMs ?? Date.now(),
      ...(pkg ? { sourcePackage: pkg } : {}),
      ...(isStandaloneOption
        ? { stripId: undefined, stripEdgeIndex: undefined }
        : {}),
    };
    // A leg fill tops up an existing strip leg; only a main bullet re-book
    // supersedes the prior cover for the CCY. An option is always a new
    // paid position beside whatever strip / forward is already live.
    setBooked(prev => {
      // Only NOW — on actual submission — does an edit of an existing
      // working order remove the original (and its OCO sibling). Closing
      // the panel earlier without submitting never reached this line.
      const base = editingOriginal
        ? retireOneOrder(prev, editingOriginal)
        : prev;
      if (isStandaloneOption) {
        return [
          ticket,
          ...clearLiveBulletForCcy(base, ticket.ccy, bookScopeId, 'option'),
        ];
      }
      const netRow = summary.rows.find(r => r.ccy === ticket.ccy);
      const keepBesideStrip =
        hedgeCoverSnapshot(
          base,
          ticket.ccy,
          netRow ? mixCoverTargetLocalM(netRow) : 0,
          1,
        ).unwind > 1e-9;
      return fillScope === 'leg' || ticket.stripId
        ? mergeStripTicketsIntoBook(base, [ticket])
        : keepBesideStrip
          ? [ticket, ...base]
          : [ticket, ...clearLiveBulletForCcy(base, ticket.ccy, bookScopeId, ticket.instrument)];
    });
    setTicketPanelKey(prev =>
      retainTicketOverlayKey(prev, ticket.ocoGroupId ?? ticket.id, 'keep'),
    );
    if (fillScope !== 'leg') {
      setEditingOriginal(null);
      setDraft(ticket);
      setViewOnly(true);
    }
    onBookHedge?.(ticket);
    if (fillScope === 'leg') return;
    setRatios({ ...ratios, [ticket.ccy]: 0 });
    if (staged) {
      setPreparedByCcy(prev => clearPreparedHedgeForCcy(prev, edited.ccy));
    }
  };

  /**
   * Leave an order working. Deliberately does far less than `confirmBook`:
   * nothing has executed, so it must not supersede live cover, must not zero
   * the hedge %, and must not clear the staged package. It only adds the
   * scheduled order — the monitor executes it if the level is reached.
   */
  const leaveRestingOrder = (ticketOrTickets: HedgeTicket | readonly HedgeTicket[]) => {
    const tickets = Array.isArray(ticketOrTickets)
      ? [...ticketOrTickets]
      : [ticketOrTickets];
    const valid = tickets.filter(
      ticket => ticket.status === 'scheduled' && ticket.limitRate != null,
    );
    if (valid.length === 0) return;
    setBooked(prev => {
      const base = editingOriginal
        ? retireOneOrder(prev, editingOriginal)
        : prev;
      return mergeStripTicketsIntoBook(base, valid);
    });
    const primary =
      valid.find(t => t.bracketRole === 'takeProfit')
      ?? valid.find(t => t.ccy === editingOriginal?.ccy && t.orderHit === editingOriginal?.orderHit)
      ?? valid[0]!;
    setEditingOriginal(null);
    setDraft(primary);
    setTicketPanelKey(prev =>
      retainTicketOverlayKey(prev, primary.ocoGroupId ?? primary.id, 'keep'),
    );
    setViewOnly(true);
  };

  const rollingStrip = useMemo(() => {
    if (!stripAvailable || effectiveStructure !== 'strip') return null;
    const eur = risk.find(r => r.bar.ccy === 'EUR') ?? risk[0];
    if (!eur) return null;
    const flowM =
      varSetup.forecastMonths > 0 && Math.abs(eur.bar.flowM) > 1e-15
        ? eur.bar.flowM
        : 0;
    const row = bookRows?.find(r => r.ccy === eur.bar.ccy);
    const custom =
      row && forecastProfile.mode === 'custom'
        ? monthlyFxFlowSeriesLocalM(row, varSetup.forecastMonths, forecastProfile)
        : undefined;
    const { flows, startM, endM } = resolveChartMonthlyFlows(
      eur.bar.stockNetM,
      flowM,
      varSetup,
      custom,
    );
    // Same Cash / VN / Target sizing as the path-chart regime (not Analytics
    // profile → Target). Growth-path Analytics used to force windowEnd (=9.1).
    const sizing = sizingForHedgePathBasis(pathBasis);
    const edges = buildRollingHedgeEdges(startM, flows, varSetup, sizing, {
      ccy: eur.bar.ccy,
      varSetup,
    });
    if (edges.length < 2) return null;
    return { ccy: eur.bar.ccy, edges, endM, sizing };
  }, [
    risk,
    varSetup,
    bookRows,
    forecastProfile,
    stripAvailable,
    effectiveStructure,
    pathBasis,
  ]);

  const stripAlreadyBooked =
    rollingStrip != null && hasRollingStripForCcy(booked, rollingStrip.ccy);
  const stripAlreadyPrepared =
    rollingStrip != null &&
    releasedLive(rollingStrip.ccy)?.structure === 'strip';

  /** Stage EUR/default strip for Decision Send (does not book live). */
  const prepareRollingStrip = () => {
    if (!rollingStrip || stripAlreadyBooked) return;
    setHedgeStructure('strip');
    const ticketBasis =
      rollingStrip.sizing === 'stockStart'
        ? 'stock'
        : rollingStrip.sizing === 'windowEnd'
          ? 'totalBuildup'
          : varSetup.exposureBasis === 'stock'
            ? 'simpleAvg'
            : varSetup.exposureBasis;
    const coverLocalM =
      rollingStrip.edges[rollingStrip.edges.length - 1]?.hedgeLocalM ?? 0;
    const profile = assignImpliedCarryFromSwapPoints(
      {
        structure: 'strip',
        basis: pathBasis,
        ticketBasis,
        legs: rollingStrip.edges.map(e => ({
          index: e.index,
          startMonth: e.startMonth,
          endMonth: e.endMonth,
          hedgeLocalM: e.hedgeLocalM,
          label: e.label,
          stockStartM: e.stockStartM,
          endExposureM: e.endExposureM,
        })),
        coverLocalM,
        hedgeRatio: 0,
      },
      {
        marketRates: resolveMarketRatesForCcy(
          marketRatesByCcy,
          rollingStrip.ccy,
          ratesScopeId,
        ),
        bulletSettleMonths:
          varSetup.forecastMonths || horizonMonths(varSetup.horizon),
        ccy: rollingStrip.ccy,
        bookRows,
        forecastProfile,
        forecastMonths: varSetup.forecastMonths,
      },
    );
    setPreparedByCcy(prev =>
      setPreparedHedgeForCcy(prev, rollingStrip.ccy, {
        ...profile,
        preparedFor: 'var',
        approvalStatus: 'approved',
      }),
    );
  };

  /**
   * Hedge Structuring — per-CCY expand/collapse card (structure/legs/shaping).
   * `structCfg` is the draft: Bullet/Strip/legs do not write `preparedByCcy`
   * until Stage (or until an already-staged package is edited). Book still
   * reads the committed package.
   */
  const [structCcy, setStructCcy] = useState<string | null>(null);
  const [structCfg, setStructCfg] = useState<Record<string, StructCfg>>({});
  const [cancelledNotices, setCancelledNotices] = useState<HedgeTicket[]>([]);
  const releasedStructFpRef = useRef<Record<string, string> | null>(null);
  useLayoutEffect(() => {
    const nextFp: Record<string, string> = {};
    for (const [ccy, p] of Object.entries(preparedByCcy)) {
      const live = livePreparedHedge(p);
      if (!live) continue;
      const ends = stripScheduleEndsFromPrepared(live);
      const ladder =
        ends != null
          ? ends.map(m => m.toFixed(4)).join('|')
          : `B:${(live.settleMonths ?? 0).toFixed(4)}`;
      nextFp[ccy] =
        `${live.structure}/${live.coverLocalM.toFixed(6)}/${live.approvalStatus ?? ''}/${ladder}`;
    }
    const prevFp = releasedStructFpRef.current;
    releasedStructFpRef.current = nextFp;
    if (prevFp == null) return;
    const ccys = new Set([...Object.keys(prevFp), ...Object.keys(nextFp)]);
    let changed = false;
    for (const ccy of ccys) {
      if ((prevFp[ccy] ?? '') !== (nextFp[ccy] ?? '')) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    setStructCfg(prevCfg => {
      let next = prevCfg;
      let copied = false;
      for (const ccy of ccys) {
        if ((prevFp[ccy] ?? '') === (nextFp[ccy] ?? '')) continue;
        if (!copied) {
          next = { ...prevCfg };
          copied = true;
        }
        const live = livePreparedHedge(preparedByCcy[ccy]);
        if (!live) {
          delete next[ccy];
          continue;
        }
        next[ccy] = structCfgFromPrepared(live, TfM);
      }
      return next;
    });
  }, [preparedByCcy, TfM]);

  useEffect(() => {
    const current = new Map<string, string>();
    const events: ExecutionLogEvent[] = [];
    const prior = ticketLifecycleRef.current;
    for (const ticket of [...booked, ...cancelledNotices]) {
      const state = ticket.status === 'cancelled'
        ? 'cancelled'
        : ticket.status === 'booked'
          ? 'filled'
          : 'working';
      current.set(ticket.id, state);
      if (prior?.get(ticket.id) === state || state === 'working') continue;
      // Fills publish too — but only CLIENT-path ones. Matcher fills already
      // produce the runtime's own FILLED lines; excluding all fills here
      // (the old rule) meant a leg executed by leg-row click reached the
      // book and the DB yet never showed up in the execution log at all.
      if (state === 'filled' && serverFilledIdsRef.current.has(ticket.id)) {
        continue;
      }
      // Stamp the actual execution instant, not the render tick — the log
      // GET dedupes on atMs+summary, so this also keeps a re-published
      // event idempotent across sessions.
      events.push(
        blotterLifecycleEvent(
          ticket,
          state,
          state === 'filled' && ticket.filledAtMs != null
            ? ticket.filledAtMs
            : undefined,
        ),
      );
    }
    ticketLifecycleRef.current = current;
    // The mount guard (prior == null) alone is defeated by async book
    // hydration: the ref baselines to an EMPTY map on first render, then
    // the sandbox book lands in one later commit and every historical
    // cancel/fill diffs against nothing — replaying the entire journal
    // into the console and re-POSTing it to /api/execution-log on every
    // page load. The first NON-EMPTY snapshot is the baseline too: those
    // tickets' transitions happened in past sessions and are already in
    // the journal. (A client fill landing in the very same commit as
    // hydration is the accepted blind spot — a seconds-wide window.)
    if (
      prior == null
      || (prior.size === 0 && current.size > 0)
      || events.length === 0
    ) {
      return;
    }
    setExecLog(prev => [...events, ...prev].slice(0, 500));
    publishExecutionLogs(events);
  }, [booked, cancelledNotices]);

  const deriveStructCfg = (ccy: string): StructCfg =>
    structCfgFromPrepared(releasedLive(ccy), TfM, structCfg[ccy]?.legCount);

  /** Cancel one ticket, or the whole strip if it belongs to a roll. */
  /**
   * Clear a dead row off the blotter. NOT a cancellation: the ticket is
   * already cancelled, so routing it through `requestCancellation` would
   * re-publish a CANCELLED notice and re-run the strip-sibling sweep — which
   * on a strip can remove FILLED siblings. This only stamps the tombstone.
   */
  const dismissTickets = (tickets: readonly HedgeTicket[]) => {
    const ids = new Set(
      tickets.filter(t => t.status === 'cancelled').map(t => t.id),
    );
    if (ids.size === 0) return;
    const atMs = Date.now();
    setBooked(prev =>
      prev.map(t =>
        ids.has(t.id) && t.dismissedAtMs == null
          ? { ...t, dismissedAtMs: atMs }
          : t,
      ),
    );
    // The bell's own copy lives under a distinct `:cancelled` id and is its
    // history, not the blotter's — drop the matching notices so clearing the
    // blotter does not leave the same dead orders ringing.
    setCancelledNotices(prev =>
      prev.filter(n => !ids.has(n.id.replace(/:cancelled$/, ''))),
    );
  };

  /** Un-hide every dismissed row for one currency. */
  const restoreDismissed = (ccy: string) => {
    setBooked(prev =>
      prev.map(t =>
        t.ccy === ccy && t.dismissedAtMs != null
          ? { ...t, dismissedAtMs: undefined }
          : t,
      ),
    );
  };

  /**
   * Cancel ONE working order — a strip leg's own — and its OCO sibling.
   * `requestCancellation` is the whole-order cancel: for a strip ticket it
   * sweeps the strip's entire unfilled remainder and restages the package,
   * which is not what a leg's own Cancel means.
   */
  const cancelWorkingOrder = (
    ticket: HedgeTicket,
    opts?: { replacedByFill?: boolean },
  ) => {
    if (ticket.status !== 'scheduled') return;
    const removed = hedgeTicketsRemovedBy(booked, { ...ticket, stripId: undefined });
    if (removed.length === 0) return;
    if (opts?.replacedByFill) {
      // Replaced by a market fill of the same leg, not cancelled by the
      // desk: no CANCELLED notice, and the row is hidden from the blotter
      // (dismissedAtMs) while the ticket stays for the chart's "where it
      // rested" level.
      const ids = new Set(removed.map(t => t.id));
      const atMs = Date.now();
      setBooked(prev =>
        retireOneOrder(prev, ticket).map(t =>
          ids.has(t.id) && t.dismissedAtMs == null ? { ...t, dismissedAtMs: atMs } : t,
        ),
      );
      return;
    }
    setCancelledNotices(prev =>
      [
        ...removed.map(t => ({
          ...t,
          id: `${t.id}:cancelled`,
          status: 'cancelled' as const,
        })),
        ...prev,
      ].slice(0, CANCELLED_NOTICE_LIMIT),
    );
    setBooked(prev => retireOneOrder(prev, ticket));
  };

  const requestCancellation = (ticket: HedgeTicket) => {
    const ccy = ticket.ccy;
    const snapshot = preparedHedgeFromBookedTickets(booked, ticket);
    // Cancelled tickets leave the book, so the bell has nothing to derive a
    // notice from — keep a copy under a distinct id (the original is already
    // marked read) so the cancellation still surfaces.
    const removed = hedgeTicketsRemovedBy(booked, ticket);
    if (removed.length > 0) {
      setCancelledNotices(prev =>
        [
          ...removed.map(t => ({
            ...t,
            id: `${t.id}:cancelled`,
            status: 'cancelled' as const,
          })),
          ...prev,
        ].slice(0, CANCELLED_NOTICE_LIMIT),
      );
    }
    setBooked(prev => removeHedgeTicketOrStrip(prev, ticket));
    if (!snapshot || Math.abs(snapshot.coverLocalM) < 1e-12) {
      setRatios({ ...ratios, [ccy]: 0 });
      return;
    }
    const withCarry =
      snapshot.impliedCarryUsdM != null
        ? snapshot
        : assignImpliedCarryFromSwapPoints(snapshot, {
            marketRates: resolveMarketRatesForCcy(
              marketRatesByCcy,
              ccy,
              ratesScopeId,
            ),
            bulletSettleMonths:
              snapshot.settleMonths ??
              (varSetup.forecastMonths || horizonMonths(varSetup.horizon)),
            ccy,
            bookRows,
            forecastProfile,
            forecastMonths: varSetup.forecastMonths,
          });
    // Read back the MERGED package, not `withCarry`: setPreparedHedgeForCcy
    // folds the cancelled ticket into whatever is already staged for this CCY,
    // so cancelling a bullet beside a staged strip leaves the strip live
    // (nested under `packages.strip`, promoted by livePreparedHedge). Deriving
    // the card from `withCarry` instead reset it to Bullet while the row header
    // still read the strip.
    const nextPrepared = setPreparedHedgeForCcy(preparedByCcy, ccy, {
      ...withCarry,
      approvalStatus: 'approved',
    });
    const live = livePreparedHedge(nextPrepared[ccy]) ?? withCarry;
    setPreparedByCcy(nextPrepared);
    setHedgeStructure(live.structure);
    setPathBasis(live.basis);
    setStructCfg(prev => ({
      ...prev,
      [ccy]: structCfgFromPrepared(live, TfM, prev[ccy]?.legCount),
    }));
    const row = summary.rows.find(r => r.ccy === ccy);
    const target = row?.targetHedgeLocalM ?? 0;
    const ratio =
      Number.isFinite(live.hedgeRatio) &&
      Math.abs(live.hedgeRatio) > 1e-6
        ? Math.min(1, Math.abs(live.hedgeRatio))
        : Math.abs(target) > 1e-12
          ? Math.min(1, Math.abs(live.coverLocalM / target))
          : 0;
    setRatios({ ...ratios, [ccy]: ratio });
  };

  /** The order an Edit on `ticket` would actually resubmit, or null. */
  const editableOrderFor = (
    ticket: HedgeTicket | null | undefined,
  ): HedgeTicket | null => {
    if (!ticket) return null;
    const { primary } = ocoDraftPrimary(booked, ticket);
    return isEditableWorkingOrder(primary) ? primary : null;
  };

  const editWorkingOrder = (ticket: HedgeTicket) => {
    const editable = editableOrderFor(ticket);
    if (editable) {
      const primary = editable;
      // Fresh mount so pad state (levels, TP/SL, limit mode) comes from the
      // working order — not leftover view/compose state on a stable tape key.
      setOverlayOpenedAtMs(null);
      setTicketPanelKey(
        retainTicketOverlayKey(null, primary.ocoGroupId ?? primary.id, 'edit'),
      );
      setEditingOriginal(primary);
      setViewOnly(false);
      setDraft(primary);
    }
  };

  /**
   * Open a working OR executed order straight from its blotter row, READ
   * ONLY — parameters and tape, no resubmission risk. Editing stays a
   * separate, explicit action (the Edit button), never a side effect of
   * just clicking a row to look at it.
   */
  const viewOrder = (ticket: HedgeTicket) => {
    const { primary } = ocoDraftPrimary(booked, ticket);
    setOverlayOpenedAtMs(null);
    setTicketPanelKey(
      retainTicketOverlayKey(null, primary.ocoGroupId ?? primary.id, 'view'),
    );
    setEditingOriginal(null);
    setViewOnly(true);
    setDraft(primary);
  };

  const ticketBasisForStruct = (basis: HedgePathBasisId): VarExposureBasis =>
    basis === 'cash'
      ? 'stock'
      : basis === 'totalExpected'
        ? 'totalBuildup'
        : varSetup.exposureBasis === 'stock'
          ? 'simpleAvg'
          : varSetup.exposureBasis;

  const buildStructuredProfile = (
    ccy: string,
    targetLocalM: number,
    structure: ForecastHedgeStructure,
    cfg: StructCfg,
    basis: HedgePathBasisId,
  ): PreparedHedgeProfile => {
    const rates = resolveMarketRatesForCcy(marketRatesByCcy, ccy, ratesScopeId);
    const bulletTf = TfM > 0 ? TfM : horizonMonths(varSetup.horizon);
    if (structure !== 'strip') {
      return assignImpliedCarryFromSwapPoints(
        {
          structure: 'bullet',
          basis,
          ticketBasis: ticketBasisForStruct(basis),
          legs: [],
          coverLocalM: targetLocalM,
          hedgeRatio: 0,
          settleMonths: cfg.t[0] ?? bulletTf,
        },
        {
          marketRates: rates,
          bulletSettleMonths: bulletTf,
          ccy,
          bookRows,
          forecastProfile,
          forecastMonths: varSetup.forecastMonths,
        },
      );
    }
    const preset =
      cfg.t.length >= 2
        ? { t: cfg.t, sh: cfg.sh }
        : structPreset(
            'strip',
            Math.max(2, cfg.legCount || 3),
            cfg.shaping,
            bulletTf,
          );
    let cum = 0;
    const legs: PreparedHedgeLeg[] = preset.t.map((t, i) => {
      const tradeNotionalLocalM = (targetLocalM * (preset.sh[i] ?? 0)) / 100;
      cum += tradeNotionalLocalM;
      return {
        index: i,
        startMonth: 0,
        endMonth: t,
        settleMonths: t,
        hedgeLocalM: cum,
        tradeNotionalLocalM,
        label: `L${i + 1}`,
      };
    });
    return assignImpliedCarryFromSwapPoints(
      {
        structure: 'strip',
        basis,
        ticketBasis: ticketBasisForStruct(basis),
        legs,
        coverLocalM: cum,
        hedgeRatio: 0,
      },
      {
        marketRates: rates,
        bulletSettleMonths: bulletTf,
        ccy,
        bookRows,
        forecastProfile,
        forecastMonths: varSetup.forecastMonths,
      },
    );
  };

  /**
   * What the trade ticket opens on. The card's leg / settle / share steppers
   * edit `structCfg` — a DRAFT — while the ticket used to read only the staged
   * package, so a schedule adjusted here never reached the modal until Stage
   * was clicked, and it read the approved-only view besides, dropping anything
   * FX Risk had staged as 'draft'. Build the ticket's package from the same
   * call the card's own table renders from, so the two cannot disagree, and it
   * recomputes on every stepper click while the modal is open.
   *
   * Only for a draft that actually opens as a strip, decided by the same
   * `ticketOpensAsStrip` the panel itself uses — one rule, read twice, rather
   * than two rules that drift. Deciding it here independently is what left an
   * unwind buy-back holding the card's six-leg draft: the panel opened it as
   * a bullet, but its Structure selector still offered "Strip · 6 staged",
   * and one click put the buy-back back on a ladder matched by edge index
   * against the filled strip's executed legs.
   */
  const preparedForTicketFromCard = (
    draft: HedgeTicket,
  ): PreparedHedgeProfile | null => {
    const staged = allPrepared[draft.ccy];
    const fromStaged = preparedForDecisionTicketPanel(draft, booked, staged);
    if (draft.stripId) return fromStaged;
    const opensAsStrip = ticketOpensAsStrip({
      ticket: draft,
      bookSession: Boolean(ticketPanelKey?.startsWith('book:')),
      decisionStructure: structureFor(draft.ccy),
      prepared: staged,
    });
    if (!opensAsStrip) return fromStaged;
    const cfg = structCfg[draft.ccy];
    if (!cfg || cfg.structure !== 'strip' || cfg.t.length < 2) return fromStaged;
    const drafted = buildStructuredProfile(
      draft.ccy,
      draft.amountLocalM,
      'strip',
      cfg,
      staged?.basis ?? pathBasis,
    );
    // Carry the staged package's regime and approval — a draft must never
    // promote itself past what the approval step decided.
    return {
      ...drafted,
      hedgeRatio: staged?.hedgeRatio ?? drafted.hedgeRatio,
      preparedFor: staged?.preparedFor ?? 'var',
      approvalStatus: staged?.approvalStatus ?? 'draft',
    };
  };

  const structPctFor = (ccy: string) => Math.round((ratios[ccy] ?? 0) * 100);
  const structureFor = (ccy: string): ForecastHedgeStructure =>
    structCfg[ccy]?.structure
    ?? releasedLive(ccy)?.structure
    ?? 'bullet';

  const structuredDraftDirty = (
    draft: PreparedHedgeProfile,
    staged: PreparedHedgeProfile,
  ): boolean => {
    if (draft.structure !== staged.structure) return true;
    if (Math.abs(draft.coverLocalM - staged.coverLocalM) > 1e-5) return true;
    if (draft.structure === 'strip') {
      if (draft.legs.length !== staged.legs.length) return true;
      return draft.legs.some((leg, i) => {
        const other = staged.legs[i];
        if (!other) return true;
        const settleA = leg.settleMonths ?? leg.endMonth;
        const settleB = other.settleMonths ?? other.endMonth;
        return (
          Math.abs(settleA - settleB) > 1e-6
          || Math.abs(leg.hedgeLocalM - other.hedgeLocalM) > 1e-5
        );
      });
    }
    return Math.abs((draft.settleMonths ?? 0) - (staged.settleMonths ?? 0)) > 1e-6;
  };

  const commitStructured = (
    ccy: string,
    ratioPct: number,
    structure: ForecastHedgeStructure,
    cfg: StructCfg,
    basis: HedgePathBasisId = pathBasis,
  ) => {
    const row = summary.rows.find(r => r.ccy === ccy);
    if (!row) return;
    const E = mixCoverTargetLocalM(row);
    const snap = hedgeCoverSnapshot(booked, ccy, E, ratioPct / 100);
    const pending = snap.trade;
    if (Math.abs(pending) < 1e-9) {
      setPreparedByCcy(prev => clearPreparedHedgeForCcy(prev, ccy));
      return;
    }
    // Same rule as the card's own preview: the configured structure is what
    // gets staged. Forcing a bullet on an overhedge here while the table
    // showed a ladder made Stage commit something other than what the desk
    // was looking at.
    const profile = buildStructuredProfile(ccy, pending, structure, cfg, basis);
    setPreparedByCcy(prev =>
      setPreparedHedgeForCcy(prev, ccy, {
        ...profile,
        hedgeRatio: Math.min(1, Math.max(0, ratioPct / 100)),
        preparedFor: 'var',
        approvalStatus: 'approved',
      }),
    );
  };

  const stageStructured = (ccy: string) => {
    const cfg = structCfg[ccy] ?? deriveStructCfg(ccy);
    const structure = structureFor(ccy);
    setHedgeStructure(structure);
    commitStructured(ccy, structPctFor(ccy), structure, cfg);
  };

  /** Cash / VaR-neutral / Target quick-apply — sets ratio; Restage if a package is already staged. */
  const applyStructRegime = (
    ccy: string,
    targetLocalM: number,
    basis: HedgePathBasisId,
  ) => {
    const row = summary.rows.find(r => r.ccy === ccy);
    const E = row ? mixCoverTargetLocalM(row) : 0;
    if (!row || Math.abs(E) < 1e-9) return;
    const snap = hedgeCoverSnapshot(booked, ccy, E, 1);
    if (Math.abs(snap.trade) < 1e-9 && snap.unwind < 1e-9) return;
    setPathBasis(basis);
    const ratio = Math.min(
      1,
      hedgeRatioForNumber(targetLocalM, E),
    );
    setRatios({ ...ratios, [ccy]: ratio });
    const cfg = structCfg[ccy] ?? deriveStructCfg(ccy);
    setStructCfg(p => ({ ...p, [ccy]: cfg }));
  };

  const setStructRatio = (ccy: string, pct: number) => {
    setRatio(ccy, pct);
  };

  const setStructStructure = (ccy: string, structure: ForecastHedgeStructure) => {
    const prev = structCfg[ccy] ?? deriveStructCfg(ccy);
    const preset = structPreset(
      structure,
      structure === 'bullet' ? 1 : Math.max(2, prev.legCount),
      prev.shaping,
      TfM,
    );
    const cfg: StructCfg = {
      ...prev,
      structure,
      legCount: structure === 'bullet' ? prev.legCount : Math.max(2, prev.legCount),
      t: preset.t,
      sh: preset.sh,
    };
    setStructCfg(p => ({ ...p, [ccy]: cfg }));
  };

  const legSettleStep = (ccy: string, i: number, dir: 1 | -1) => {
    const cfg = structCfg[ccy] ?? deriveStructCfg(ccy);
    const t = cfg.t.map((v, j) =>
      j === i ? Math.max(0.5, Math.min(TfM || v, +(v + dir * 0.5).toFixed(1))) : v,
    );
    const next: StructCfg = { ...cfg, structure: 'strip', t };
    setStructCfg(p => ({ ...p, [ccy]: next }));
  };

  const legShareStep = (ccy: string, i: number, dir: 1 | -1) => {
    const cfg = structCfg[ccy] ?? deriveStructCfg(ccy);
    const sh = cfg.sh.map((v, j) => (j === i ? Math.max(0, Math.min(100, v + dir * 5)) : v));
    const next: StructCfg = { ...cfg, structure: 'strip', sh };
    setStructCfg(p => ({ ...p, [ccy]: next }));
  };

  const rebalanceLegs = (ccy: string) => {
    const cfg = structCfg[ccy] ?? deriveStructCfg(ccy);
    const next: StructCfg = { ...cfg, structure: 'strip', sh: rebalanceShares(cfg.sh) };
    setStructCfg(p => ({ ...p, [ccy]: next }));
  };

  const shell = embedded
    ? 'rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-200'
    : 'rounded-xl border border-gray-200 bg-white p-5 text-gray-900';
  const muted = embedded ? 'text-slate-500' : 'text-gray-500';
  const head = embedded ? 'text-slate-500' : 'text-gray-500';
  const border = embedded ? 'border-slate-800' : 'border-gray-200';
  const structRowGrid =
    'grid w-full min-w-[58rem] grid-cols-[2.4rem_2.85rem_5.5rem_5.5rem_6.2rem_5.75rem_3.6rem_3.6rem_minmax(4.5rem,1fr)_5.75rem_5.75rem_3.6rem_3.6rem_0.85rem] items-baseline gap-x-2 px-3';

  /** FX Exposure overview — read-only per-currency snapshot (Cash Carry-style summary table). */
  const exposureOverviewRows = useMemo(() => {
    return summary.rows.map(r => {
      const riskRow = riskByCcy.get(r.ccy);
      const stockRaw = riskRow?.bar.stockNetM ?? r.stockHedgeLocalM;
      const flowRaw = riskRow?.bar.flowM ?? 0;
      const grossM = mixCoverTargetLocalM(r);
      const snap = hedgeCoverSnapshot(booked, r.ccy, grossM, 1);
      const totalM = snap.residual;
      const flowForVar =
        varSetup.forecastMonths > 0 && Math.abs(flowRaw) > 1e-15
          ? flowRaw
          : 0;
      const varStock = computeAnalyticsVarUsdM(stockRaw, 0, r.ccy, {
        ...varSetup,
        exposureBasis: 'stock',
      });
      const varTotal = computeAnalyticsVarUsdM(stockRaw, flowForVar, r.ccy, {
        ...varSetup,
        exposureBasis: 'totalBuildup',
      });
      const direction: 'long' | 'short' | 'flat' =
        Math.abs(grossM) < 1e-9
          ? Math.abs(snap.covering) < 1e-9
            ? 'flat'
            : snap.coveringSign > 0
              ? 'long'
              : 'short'
          : grossM > 0
            ? 'long'
            : 'short';
      const flows = monthlyFlowsByCcy[r.ccy];
      const flowHorizonM =
        flows && flows.length > 0
          ? flows.reduce((s, f) => s + f, 0)
          : flowRaw * Math.max(0, varSetup.forecastMonths);
      return {
        ccy: r.ccy,
        stockM: stockRaw,
        flowM: flowHorizonM,
        totalM,
        coveringSigned: snap.coveringSigned,
        existingSigned: snap.existingSigned,
        pendingSigned: snap.pendingSigned,
        pendingCover: snap.pending,
        varStock,
        varTotal,
        direction,
      };
    });
  }, [summary.rows, riskByCcy, varSetup, monthlyFlowsByCcy, booked]);

  const exposureOverviewTotals = useMemo(
    () =>
      exposureOverviewRows.reduce(
        (a, r) => ({
          varStock: a.varStock + r.varStock,
          varTotal: a.varTotal + r.varTotal,
        }),
        { varStock: 0, varTotal: 0 },
      ),
    [exposureOverviewRows],
  );

  const exposureByCcy = useMemo(() => {
    const m = new Map<string, (typeof exposureOverviewRows)[number]>();
    for (const row of exposureOverviewRows) m.set(row.ccy, row);
    return m;
  }, [exposureOverviewRows]);

  const perspectiveTabStats = useMemo((): Partial<
    Record<RiskPerspective, RiskPerspectiveTabStat>
  > => {
    const resid = summary.totalVarAfterUsdM;
    const residLabel =
      !Number.isFinite(resid) || Math.abs(resid) < 1e-12
        ? '—'
        : Math.abs(resid) >= 0.1
          ? `$${resid.toFixed(2)}M`
          : `$${(resid * 1000).toFixed(1)}K`;
    return {
      fxRisk: { value: residLabel, label: 'Resid VaR' },
    };
  }, [summary.totalVarAfterUsdM]);

  const draftPathExposure = useMemo(() => {
    if (!draft) return null;
    const row = summary.rows.find(r => r.ccy === draft.ccy);
    const seed = risk.find(r => r.bar.ccy === draft.ccy);
    if (!row || !seed) return null;
    const prep = preparedByCcy[draft.ccy];
    const E = mixCoverTargetLocalM(row);
    const bookedCover =
      row.bookedCoverLocalM ?? bookedNotionalLocalM(booked, draft.ccy);
    const clip = draft.amountLocalM;
    const hedgeRatio =
      Math.abs(E) > 1e-9
        ? Math.min(1, Math.abs(clip) / Math.abs(E))
        : prep?.hedgeRatio && prep.hedgeRatio > 1e-9
          ? prep.hedgeRatio
          : row.hedgeRatio;
    return {
      stockM: seed.bar.stockNetM,
      monthlyFlowM:
        varSetup.forecastMonths > 0 && Math.abs(seed.bar.flowM) > 1e-15
          ? seed.bar.flowM
          : 0,
      monthlyFlows: monthlyFlowsByCcy[draft.ccy],
      equalVarHedgeLocalM: row.equalVarHedgeLocalM,
      endExposureM: E,
      bookedCoverLocalM: bookedCover,
      selectedBasis: prep?.basis ?? pathBasis,
      hedgeRatio,
    };
  }, [
    draft,
    summary.rows,
    risk,
    preparedByCcy,
    varSetup.forecastMonths,
    monthlyFlowsByCcy,
    pathBasis,
    booked,
  ]);

  return (
    <div className={`space-y-4 ${shell}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold tracking-tight text-slate-50">
            Hedging Decision
          </h3>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">
            Resid VaR{' '}
            <span className="font-semibold text-slate-300">
              {perspectiveTabStats.fxRisk?.value ?? '—'}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {rollingStrip && (
            <button
              type="button"
              onClick={prepareRollingStrip}
              disabled={stripAlreadyBooked}
              title={
                stripAlreadyBooked
                  ? 'Strip already on the live book — Cancel strip to re-stage'
                  : stripAlreadyPrepared
                    ? `Replace staged ${rollingStrip.edges.length}-leg strip — then Book under ${rollingStrip.ccy}`
                    : `Stage ${rollingStrip.edges.length} forwards from M0 — Book under ${rollingStrip.ccy}`
              }
              className="rounded-md border border-violet-500/50 bg-violet-500/20 px-2.5 py-1 text-[11px] font-semibold text-violet-100 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {stripAlreadyBooked
                ? 'Strip booked'
                : stripAlreadyPrepared
                  ? `Staged ${rollingStrip.edges.length}-leg strip`
                  : `Stage ${rollingStrip.edges.length}-leg strip`}
            </button>
          )}
          <button
            type="button"
            onClick={() => hedgeAll(0)}
            className="rounded-md border border-slate-600 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            Unhedged
          </button>
          {varSetup.forecastMonths != null && (
            <span className="inline-flex items-baseline gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-2 py-0.5 text-[11px] text-slate-500">
              Tf
              <span className="font-mono font-semibold tabular-nums text-sky-200">
                {varSetup.forecastMonths === 0
                  ? '0m'
                  : `${varSetup.forecastMonths}m`}
              </span>
            </span>
          )}
        </div>
      </div>

      <div className={`flex items-center gap-1 border-b ${border} pb-2`}>
        <button
          type="button"
          onClick={() => setHedgeTab('decision')}
          className={`rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
            hedgeTab === 'decision'
              ? 'bg-slate-700 text-slate-50'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          Decision
        </button>
        <button
          type="button"
          onClick={() => setHedgeTab('orders')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
            hedgeTab === 'orders'
              ? 'bg-slate-700 text-slate-50'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          Order monitor
          {execLog.length > 0 && (
            <span className="font-mono text-[9px] font-normal normal-case text-slate-400">
              {execLog.filter(e => e.kind === 'order').length || execLog.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setHedgeTab('blotter')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
            hedgeTab === 'blotter'
              ? 'bg-slate-700 text-slate-50'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          Blotter
          {booked.length > 0 && (
            <span className="font-mono text-[9px] font-normal normal-case text-slate-400">
              {booked.filter(isLiveHedgeTicket).length}
            </span>
          )}
        </button>
      </div>

      {hedgeTab === 'orders' && (
        <ExecutionMonitorPanel events={monitorFeed} heartbeat={matchingHb} />
      )}

      {hedgeTab === 'blotter' && (
        <section
          className={
            embedded
              ? 'rounded-lg border border-slate-700 bg-slate-950/40'
              : `rounded-lg border ${border}`
          }
        >
          <TicketBlotter
            tickets={booked}
            border={border}
            head={head}
            muted={muted}
          />
        </section>
      )}

      {hedgeTab === 'decision' && (
      <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="VaR at Δ = 1"
          value={fmtVarK(summary.totalVarBeforeUsdM)}
          hint="Open book (before hedges) · undiversified Σ"
          embedded={embedded}
        />
        <Stat
          label="VaR after hedge"
          value={fmtVarK(summary.totalVarAfterUsdM)}
          hint={
            booked.length > 0 || summary.rows.some(r => r.hedgeRatio > 1e-9)
              ? 'Residual after booked / hedge %'
              : 'No hedge yet — same as Δ = 1'
          }
          embedded={embedded}
          accent
        />
        <Stat
          label="VaR reduction"
          value={fmtVarK(summary.varReductionUsdM)}
          hint={
            summary.totalVarBeforeUsdM > 1e-12
              ? `${((summary.varReductionUsdM / summary.totalVarBeforeUsdM) * 100).toFixed(0)}% cut`
              : 'Unhedged − residual'
          }
          embedded={embedded}
        />
      </div>

      <section
        className={
          embedded
            ? 'rounded-lg border border-slate-700 bg-slate-950/40 p-3'
            : `rounded-lg border ${border} p-3`
        }
      >
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
            Exposure · hedge structuring
          </div>
          <div className="font-mono text-[9px] text-slate-600">
            {TfM}m horizon · {summary.rows.length} currencies ·{' '}
            {(() => {
              const desk = decisionCcyOrderCounts(booked);
              if (desk.filled + desk.pending === 0) return 'nothing booked';
              return [
                desk.filled > 0 ? `${desk.filled} filled` : null,
                desk.pending > 0 ? `${desk.pending} pending` : null,
              ]
                .filter(Boolean)
                .join(' · ');
            })()}
          </div>
        </div>
        <div className="overflow-x-auto">
        <div className={`${structRowGrid} border-b ${border} py-1.5 ${head}`}>
          <span className="text-[9px] font-medium uppercase tracking-wide">
            CCY
          </span>
          <span className="text-[9px] font-medium uppercase tracking-wide">
            Dir
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide"
            title="Net FX book at t=0 = Cash FX + receivables − debt. Not the cash balance."
          >
            Stock
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide"
            title="FX-changing flow over the horizon. Collecting AR already in Stock is cash, not extra FX."
          >
            Flow
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide"
            title="Filled covering plus working orders still to settle (OCO counted once). Opposite-sign options are hedge budget, not cover."
          >
            Hedge
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide"
            title="Outstanding after covering (forecast − filled − pending settlement). Negative = overhedged — Book is a buy-back."
          >
            Net
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide text-amber-300/90"
            title="Undiversified VaR on Stock only"
          >
            VaRs
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide text-emerald-300/80"
            title="Undiversified VaR on Net exposure"
          >
            VaRn
          </span>
          <span className="text-[9px] font-medium uppercase tracking-wide">
            Structure
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide"
            title="Hedge to flatten Net — opposite sign (long Net → sell, short Net → buy)."
          >
            Target
          </span>
          <span className="text-right text-[9px] font-medium uppercase tracking-wide">
            Resid
          </span>
          <span className="text-right text-[9px] font-medium uppercase tracking-wide">
            VaR
          </span>
          <span className="text-right text-[9px] font-medium uppercase tracking-wide">
            Carry
          </span>
          <span />
        </div>
        {summary.rows.map(r => {
              const riskRow = riskByCcy.get(r.ccy);
              const stockRaw = riskRow?.bar.stockNetM ?? r.stockHedgeLocalM;
              const flowRaw = riskRow?.bar.flowM ?? 0;
              const stockM = r.stockHedgeLocalM;
              const totalM = mixCoverTargetLocalM(r);
              const mixW = ratios[r.ccy] ?? r.hedgeRatio;
              const prepared = releasedLive(r.ccy);
              const bookW =
                prepared && prepared.hedgeRatio > 1e-9
                  ? prepared.hedgeRatio
                  : mixW > 1e-9
                    ? mixW
                    : 1;
              const atFull = hedgeCoverSnapshot(booked, r.ccy, totalM, 1);
              const atBook = hedgeCoverSnapshot(booked, r.ccy, totalM, bookW);
              const leftoverAfterBooked = atFull.residual;
              const executeClip = atBook.trade;
              const overspendLocalM = atFull.unwind;
              const netExposureM = atFull.residual;
              const hedgeTargetTradeM = atBook.flattenTrade;
              const flowForVar =
                varSetup.forecastMonths > 0 && Math.abs(flowRaw) > 1e-15
                  ? flowRaw
                  : 0;
              const varNeutralM =
                varSetup.exposureBasis === 'stock'
                  ? (() => {
                      const eq = equalVarLinearHedgeNotionalLocalM(
                        stockRaw,
                        flowForVar,
                        r.ccy,
                        pathRegimeSetup,
                        undefined,
                        monthlyFlowsByCcy[r.ccy],
                      ).amountLocalM;
                      const sign = totalM >= 0 || stockM >= 0 ? 1 : -1;
                      return sign * Math.abs(eq);
                    })()
                  : r.equalVarHedgeLocalM;
              const varNeutralUsd = computeParametricVarUsdM(
                varNeutralM,
                r.ccy,
                pathRegimeSetup,
              );
              const flat =
                Math.abs(leftoverAfterBooked) < 1e-9
                && Math.abs(executeClip) < 1e-9;
              const canBook = Math.abs(executeClip) > 1e-9;
              const isUnwind = atFull.unwind > 1e-9;
              const stripBooked = hasRollingStripForCcy(booked, r.ccy);
              const overview = exposureByCcy.get(r.ccy);
              const direction = overview?.direction ?? (flat ? 'flat' : netExposureM > 0 ? 'long' : 'short');
              const regimeLabel =
                prepared?.basis === 'cash'
                  ? 'Expected stock'
                  : prepared?.basis === 'totalExpected'
                    ? 'Target'
                    : prepared?.basis === 'varNeutral'
                      ? 'VaR-neutral'
                      : null;
              const bookedForCcy = booked
                .filter(t => t.ccy === r.ccy)
                .sort(
                  (a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0),
                );
              const stripStarted = stripExecutionStarted(
                bookedForCcy.filter(t => Boolean(t.stripId)),
              );
              // The hedge table lists EVERY ticket for the CCY. It used to
              // exclude strip cover legs because the STRUCTURE table above
              // displayed them — but since that table describes the NEXT
              // draft strip (7dbd068), executed strip legs appeared nowhere
              // on the Decision screen: booked in the DB, invisible and
              // uncancellable in the UI. This table is their only home now.
              //
              // Except an OCO sibling the fill auto-cancelled. It is kept in
              // `booked` so the ticket panel can draw the grey level where it
              // rested, but it is not an order the desk placed or filled:
              // listing it printed a CANCELED row beside the FILLED stop
              // (0.00 filled / 0.00 working) at the same tenor. Hide it here;
              // the cancelled chrome belongs on the TP/SL pad, not the blotter.
              const blotterTickets = bookedForCcy.filter(
                t =>
                  !(t.status === 'cancelled' && t.ocoGroupId != null)
                  // Dismissed rows are hidden here only. The ticket stays in
                  // `booked` because a cancelled order is still the source of
                  // its leg's grey resting level, can carry the strip's
                  // sourcePackage ladder shape, and takes part in edge
                  // resolution — deleting it breaks all three.
                  && t.dismissedAtMs == null,
              );
              // Dead rows the desk can clear in one go: cancelled, not an
              // auto-cancelled OCO sibling (already hidden above), not
              // already dismissed.
              const dismissableTickets = bookedForCcy.filter(
                t =>
                  t.status === 'cancelled'
                  && t.ocoGroupId == null
                  && t.dismissedAtMs == null,
              );
              const dismissedCount = bookedForCcy.filter(
                t => t.dismissedAtMs != null,
              ).length;
              const preparedLegs =
                prepared?.structure === 'strip' && prepared.legs.length > 0
                  ? prepared.legs
                  : prepared
                    ? [
                        {
                          index: 0,
                          startMonth: 0,
                          endMonth: TfM,
                          settleMonths:
                            prepared.settleMonths != null
                              ? prepared.settleMonths
                              : TfM,
                          hedgeLocalM: prepared.coverLocalM,
                          label: `M0–M${Math.round(
                            prepared.settleMonths != null
                              ? prepared.settleMonths
                              : TfM,
                          )}`,
                          tradeNotionalLocalM: prepared.coverLocalM,
                          impliedCarryUsdM: prepared.impliedCarryUsdM,
                          swapPoints: prepared.swapPoints,
                          swapPointsSide: prepared.swapPointsSide,
                        },
                      ]
                    : [];
              const orderCounts = decisionCcyOrderCounts(bookedForCcy);
              const open = structCcy === r.ccy;
              const cfg = structCfg[r.ccy] ?? deriveStructCfg(r.ccy);
              const structure = structureFor(r.ccy);
              const isStrip = structure === 'strip';
              const previewNotional = executeClip;
              // The table shows the ladder the card is configured for, at all
              // times. It used to force a bullet whenever covering exceeded
              // target, so an overhedge collapsed a six-leg draft to a single
              // row and the stepper disagreed with its own table. The
              // buy-back is still stated — Hedge target, the Book button and
              // the caption all name it — but it no longer replaces the
              // ladder the desk is shaping.
              const previewProfile = open
                ? Math.abs(previewNotional) > 1e-9
                  ? buildStructuredProfile(
                      r.ccy,
                      previewNotional,
                      structure,
                      cfg,
                      prepared?.basis ?? pathBasis,
                    )
                  : prepared ?? null
                : null;
              // The Bullet/Strip toggle is authoritative for this table: the
              // zero-clip fallback shows the STAGED package (which can be a
              // strip), and rendering its 7 legs under a toggle that says
              // Bullet is incoherent — collapse to the single aggregate row
              // whenever the toggle says bullet.
              //
              // Whether the rows ARE strip legs is a separate question from
              // what the toggle says, and the row chrome below must follow
              // this one, not the toggle. An unwind forces the preview to a
              // bullet buy-back (legs empty) while the toggle still reads
              // Strip because the filled strip is staged — the single
              // buy-back row was then drawn as "L1" with per-leg settle and
              // share steppers, i.e. as leg 1 of a ladder it is not part of.
              const previewIsStrip =
                previewProfile != null
                && previewProfile.structure === 'strip'
                && previewProfile.legs.length > 0
                && isStrip;
              const previewLegs =
                previewProfile == null
                  ? preparedLegs
                  : previewIsStrip
                    ? previewProfile.legs
                    : [
                        {
                          index: 0,
                          startMonth: 0,
                          endMonth:
                            previewProfile.settleMonths != null
                              ? previewProfile.settleMonths
                              : TfM,
                          settleMonths:
                            previewProfile.settleMonths != null
                              ? previewProfile.settleMonths
                              : TfM,
                          hedgeLocalM: previewProfile.coverLocalM,
                          label: `M0–M${Math.round(
                            previewProfile.settleMonths != null
                              ? previewProfile.settleMonths
                              : TfM,
                          )}`,
                          tradeNotionalLocalM: previewProfile.coverLocalM,
                          impliedCarryUsdM: previewProfile.impliedCarryUsdM,
                          swapPoints: previewProfile.swapPoints,
                          swapPointsSide: previewProfile.swapPointsSide,
                        },
                      ];
              // Σ share still lives on this card (per-leg table). Leg count
              // and Equal / Front / Carry shaping moved to Book — they were
              // clipped off this toolbar and not usable here.
              const showStripShapeControls = isStrip;
              // Per-leg settle / share steppers lock once the strip has a
              // working or filled order, or there is nothing left to book.
              const shapeLockedReason = stripStarted
                ? 'This strip already has a working or filled order — remaining clip trades as Spot / FWD / Option. Cancel the strip to reshape legs.'
                : canBook
                  ? null
                  : 'Covering already matches target — nothing to book, so the ladder cannot be reshaped. Cancel the strip to rebook.';
              const shapeLocked = shapeLockedReason != null;
              // Counted off the rows the table actually renders, so the
              // caption and the table cannot disagree. It used to count the
              // STAGED package instead, which is how the card read
              // "3 staged strip" beside a stepper showing 6.
              const structureCaption = decisionStructureCaption({
                stagedLegs: previewLegs.length,
                stagedKind: previewIsStrip
                  ? 'strip'
                  : prepared
                    ? prepared.structure === 'strip'
                      ? 'strip'
                      : 'bullet'
                    : null,
                isStrip,
                draftLegCount: cfg.legCount,
                pending: orderCounts.pending,
                filled: orderCounts.filled,
                isUnwind,
              });
              // The card always describes the NEXT strip — default or adjusted
              // — never the one already on the book. A booked strip used to
              // take unconditional precedence here, which pinned the table to
              // the filled legs, made every stepper inert, and meant a new
              // hedge could not be shaped after booking. Booked legs are real
              // positions and live in the blotter rows below instead.
              const structLegs = previewLegs;
              // Settle per leg on the ladder the strip was executed on. Read
              // straight off settleMonths, a filled SPOT strip shows M0 on
              // every row (T+2 cash settle) instead of its real windows.
              const structLegMonths = stripLadderMonths(structLegs);
              const sumShare = cfg.sh.reduce((a, b) => a + b, 0);
              const needsRebalance =
                showStripShapeControls && Math.abs(sumShare - 100) > 0.05;
              const draftDirty =
                prepared != null
                && previewProfile != null
                && structuredDraftDirty(previewProfile, prepared);
              const showStage =
                !flat && Math.abs(structPctFor(r.ccy)) >= 1e-9;
              const shapeBtn = (on: boolean) =>
                `rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  on
                    ? 'bg-violet-500/25 text-violet-100'
                    : `${muted} hover:text-slate-300`
                }`;
              /**
               * Locked carry / M2M — only computed for the open row (the
               * ladder engine also prices VaR/CFaR profiles, not cheap to run
               * per collapsed row).
               *
               * "Locked" follows the SAME regime-or-booked precedence as
               * buildTenorRiskLadder's own coverPreparedForLadder: a staged
               * package (the regime currently being modeled) takes priority;
               * only with nothing staged does it read the actually-booked
               * hedges. M2M is read from the same ladder call, so both
               * numbers describe the identical assumed position — showing
               * booked-only carry next to staged-regime M2M (or vice versa)
               * would silently mix two different bases.
               */
              const bookRowForCcy = open
                ? (bookRows?.find(x => x.ccy === r.ccy) ?? null)
                : null;
              const tenorLadder = bookRowForCcy
                ? buildTenorRiskLadder({
                    ccy: r.ccy,
                    row: bookRowForCcy,
                    stockM: stockRaw,
                    monthlyFlowM: flowRaw,
                    monthlyFlows: monthlyFlowsByCcy[r.ccy],
                    setup: varSetup,
                    bookedHedges: booked,
                    prepared,
                    hedgeNotionalLocalM: r.hedgeNotionalLocalM,
                    forecastProfile,
                    marketRates: resolveMarketRatesForCcy(
                      marketRatesByCcy,
                      r.ccy,
                      ratesScopeId,
                    ),
                  })
                : [];
              const nextForecastMonths =
                TfM > 0 ? TfM : horizonMonths(varSetup.horizon);
              const ladderPoint =
                tenorLadder.length > 0
                  ? tenorLadder.reduce((best, p) =>
                      Math.abs(p.months - nextForecastMonths)
                      < Math.abs(best.months - nextForecastMonths)
                        ? p
                        : best,
                    )
                  : null;
              const hasStagedRegime =
                Math.abs(prepared?.coverLocalM ?? 0) > 1e-12;
              const hedgeCarryUsdM = modeledHedgeCarryUsdM(prepared, bookedForCcy);
              const lockedCarryUsdM =
                ladderPoint == null
                  ? null
                  : hedgeCarryUsdM + ladderPoint.cashCarryUsdM;
              const m2mUsdM = ladderPoint?.m2mUsdM ?? null;
              return (
                <Fragment key={r.ccy}>
                  <div
                    role="button"
                    tabIndex={0}
                    title={`Structure ${r.ccy} hedge`}
                    onClick={() => setStructCcy(open ? null : r.ccy)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setStructCcy(open ? null : r.ccy);
                      }
                    }}
                    className={`${structRowGrid} cursor-pointer border-b ${border}/60 py-1.5 ${
                      open
                        ? 'bg-violet-500/10'
                        : 'bg-slate-950/30 hover:bg-violet-500/10'
                    } ${flat ? 'opacity-50' : ''}`}
                  >
                    <span className="text-[13px] font-semibold text-violet-200">
                      {r.ccy}
                    </span>
                    <span>
                      <span
                        className={`rounded px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide ${
                          direction === 'long'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : direction === 'short'
                              ? 'bg-rose-500/15 text-rose-300'
                              : 'bg-slate-700/50 text-slate-500'
                        }`}
                      >
                        {direction}
                      </span>
                    </span>
                    <span className="text-right font-mono text-[11px] tabular-nums text-slate-300">
                      {fmtLocal(overview?.stockM ?? stockM, r.ccy)}
                    </span>
                    <span
                      className={`text-right font-mono text-[11px] tabular-nums ${
                        Math.abs(overview?.flowM ?? flowRaw) < 1e-9
                          ? 'text-slate-600'
                          : 'text-slate-300'
                      }`}
                    >
                      {Math.abs(overview?.flowM ?? flowRaw) < 1e-9
                        ? '—'
                        : fmtLocal(overview?.flowM ?? flowRaw, r.ccy)}
                    </span>
                    <span
                      className={`text-right font-mono text-[11px] tabular-nums ${
                        Math.abs(atFull.covering) < 1e-9 ? 'text-slate-600' : 'text-sky-200'
                      }`}
                      title={
                        atFull.pending > 1e-9
                          ? `Filled ${fmtLocal(atFull.existingSigned, r.ccy)} · pending settlement ${fmtLocal(atFull.pendingSigned, r.ccy)}`
                          : 'Filled covering (same direction as the forecast)'
                      }
                    >
                      {Math.abs(atFull.covering) < 1e-9
                        ? '—'
                        : (
                          <>
                            {fmtLocal(atFull.coveringSigned, r.ccy)}
                            {atFull.pending > 1e-9 ? (
                              <span className="mt-0.5 block text-[8px] font-medium uppercase tracking-wide text-amber-300/80">
                                pend. {fmtLocal(atFull.pendingSigned, r.ccy)}
                              </span>
                            ) : null}
                          </>
                        )}
                    </span>
                    <span
                      className={`text-right font-mono text-[11px] font-semibold tabular-nums ${
                        overspendLocalM > 0.005 ? 'text-rose-300' : 'text-violet-200'
                      }`}
                      title={
                        overspendLocalM > 0.005
                          ? `Overhedged by ${fmtLocal(overspendLocalM, r.ccy)} — Book is a buy-back; filled strip stays.`
                          : 'Outstanding after covering (forecast − filled − pending settlement)'
                      }
                    >
                      {fmtLocal(netExposureM, r.ccy)}
                    </span>
                    <span className="text-right font-mono text-[11px] tabular-nums text-amber-300">
                      {overview ? fmtVarK(overview.varStock) : '—'}
                    </span>
                    <span className="text-right font-mono text-[11px] font-semibold tabular-nums text-emerald-300">
                      {overview ? fmtVarK(overview.varTotal) : '—'}
                    </span>
                    <span
                      className={`truncate text-[9px] ${muted}`}
                      title={structureCaption}
                    >
                      {structureCaption}
                    </span>
                    <span className="text-right font-mono text-[11px] font-semibold tabular-nums text-sky-300">
                      {fmtLocal(hedgeTargetTradeM, r.ccy)}
                    </span>
                    <span
                      className={`text-right font-mono text-[11px] tabular-nums ${
                        Math.abs(r.residualLocalM) < 1e-9
                          ? muted
                          : 'text-amber-300'
                      }`}
                    >
                      {fmtLocal(r.residualLocalM, r.ccy)}
                    </span>
                    <span
                      className={`text-right font-mono text-[11px] font-semibold tabular-nums ${
                        r.varAfterUsdM < r.varBeforeUsdM - 1e-9
                          ? 'text-emerald-300'
                          : 'text-amber-300'
                      }`}
                    >
                      {fmtVarK(r.varAfterUsdM)}
                    </span>
                    <span className="text-right font-mono text-[11px] font-semibold tabular-nums text-emerald-300">
                      {prepared?.impliedCarryUsdM != null
                        ? fmtVarK(prepared.impliedCarryUsdM)
                        : '—'}
                    </span>
                    <span className={`text-center text-[9px] ${muted}`}>
                      {open ? '▾' : '▸'}
                    </span>
                  </div>
                  {open && (
                    <div className="border-b border-slate-800 bg-slate-950/40">
                      <div className="flex flex-col gap-3 px-3 py-3.5">
                      <div className="flex flex-wrap items-center gap-4">
                        <div className="flex flex-col gap-1">
                          <span className="text-[9px] uppercase tracking-wide text-slate-500">
                            FX stock
                          </span>
                          <span className={`font-mono text-xs ${muted}`}>
                            {fmtLocal(stockM, r.ccy)}
                          </span>
                        </div>
                        <QuickApplyReadout
                          label="VaR-neutral"
                          valueLocalM={varNeutralM}
                          ccy={r.ccy}
                          varUsdM={varNeutralUsd}
                          disabled={flat || Math.abs(varNeutralM) < 1e-9}
                          onApply={() =>
                            applyStructRegime(r.ccy, varNeutralM, 'varNeutral')
                          }
                        />
                        <div className="flex flex-col gap-1">
                          <span className="text-[9px] uppercase tracking-wide text-slate-500">
                            Net exposure
                          </span>
                          <span
                            className={`font-mono text-xs ${
                              overspendLocalM > 0.005 ? 'text-rose-300' : muted
                            }`}
                          >
                            {fmtLocal(netExposureM, r.ccy)}
                          </span>
                          {overspendLocalM > 0.005 ? (
                            <span className="text-[9px] font-semibold uppercase tracking-wide text-rose-300">
                              Overspent {fmtLocal(overspendLocalM, r.ccy)}
                            </span>
                          ) : null}
                        </div>
                        <DeskStepper
                          label="Hedge"
                          value={Math.round(r.hedgeRatio * 100)}
                          min={0}
                          max={MAX_HEDGE_PCT}
                          step={1}
                          nudgeStep={HEDGE_STEP_PCT}
                          onChange={pct => setStructRatio(r.ccy, pct)}
                          formatValue={v => `${v}%`}
                          suffix={`→ ${fmtLocal(hedgeTargetTradeM, r.ccy)}`}
                          editable
                          disabled={flat}
                          tickValues={[0, 25, 50, 75, 100]}
                          layout="inline"
                          className="w-[22rem] sm:w-[26rem] lg:w-[30rem] xl:w-[34rem] max-w-full"
                          title={
                            flat
                              ? 'No net exposure to hedge'
                              : `Scale hedge % of leftover Net (0–${MAX_HEDGE_PCT}%)`
                          }
                          ariaLabel="Hedge percent"
                        />
                        <div className="flex flex-col gap-1">
                          <span className="text-[9px] uppercase tracking-wide text-slate-500">
                            Hedge target
                          </span>
                          <span
                            className="font-mono text-sm font-semibold text-sky-300"
                            title="Trade to flatten Net — opposite sign of leftover exposure."
                          >
                            {fmtLocal(hedgeTargetTradeM, r.ccy)}
                          </span>
                        </div>
                        <div
                          className="flex flex-col gap-1"
                          title={
                            hasStagedRegime
                              ? `Hedge carry from the staged regime (${
                                  fmtSignedVarK(hedgeCarryUsdM)
                                }) + cash carry (${
                                  ladderPoint
                                    ? fmtSignedVarK(ladderPoint.cashCarryUsdM)
                                    : '—'
                                }) through the next forecast period (${nextForecastMonths.toFixed(0)}m). Nothing is staged → falls back to actually-booked hedges.`
                              : `Booked-hedge carry (${
                                  fmtSignedVarK(hedgeCarryUsdM)
                                }) + cash carry (${
                                  ladderPoint
                                    ? fmtSignedVarK(ladderPoint.cashCarryUsdM)
                                    : '—'
                                }) through the next forecast period (${nextForecastMonths.toFixed(0)}m).`
                          }
                        >
                          <span className="text-[9px] uppercase tracking-wide text-slate-500">
                            Locked carry
                          </span>
                          <span
                            className={`font-mono text-sm font-semibold ${
                              lockedCarryUsdM == null
                                ? muted
                                : lockedCarryUsdM >= 0
                                  ? 'text-emerald-300'
                                  : 'text-rose-300'
                            }`}
                          >
                            {lockedCarryUsdM == null ? '—' : fmtSignedVarK(lockedCarryUsdM)}
                          </span>
                        </div>
                        <div
                          className="flex flex-col gap-1"
                          title="Non-carry P&L: the FX mark on whatever this CCY's exposure is NOT covered by the modeled regime (swap points off the traded curve when loaded, else CIP)."
                        >
                          <span className="text-[9px] uppercase tracking-wide text-slate-500">
                            M2M
                          </span>
                          <span
                            className={`font-mono text-sm font-semibold ${
                              m2mUsdM == null
                                ? muted
                                : m2mUsdM >= 0
                                  ? 'text-emerald-300'
                                  : 'text-rose-300'
                            }`}
                          >
                            {m2mUsdM == null ? '—' : fmtSignedVarK(m2mUsdM)}
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={flat}
                          title="Open hedge path — Stage from the chart, then Book here"
                          onClick={e => {
                            e.stopPropagation();
                            openPathChart(r.ccy);
                          }}
                          className="ml-auto rounded-md border border-violet-500/50 bg-violet-500/15 px-2.5 py-1 text-[11px] font-semibold text-violet-200 hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          Hedge path
                        </button>
                      </div>

                      <div
                        className={`flex flex-wrap items-center gap-4 border-y ${border} py-2.5`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] uppercase tracking-wide text-slate-500">
                            Structure
                          </span>
                          <span className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5">
                            <button
                              type="button"
                              onClick={() => setStructStructure(r.ccy, 'bullet')}
                              className={shapeBtn(!isStrip)}
                            >
                              Bullet
                            </button>
                            <button
                              type="button"
                              disabled={!stripAvailable}
                              onClick={() => setStructStructure(r.ccy, 'strip')}
                              className={`${shapeBtn(isStrip)} disabled:cursor-not-allowed disabled:opacity-40`}
                            >
                              Strip
                            </button>
                          </span>
                        </div>
                        <span
                          className={`font-mono text-[10px] ${muted}`}
                          title={structureCaption}
                        >
                          {structureCaption}
                        </span>

                        <span className="flex-1" />
                        <span
                          className={`text-[10px] ${
                            needsRebalance ? 'text-amber-300' : muted
                          }`}
                        >
                          {showStripShapeControls
                            ? needsRebalance
                              ? `Σ share ${fmtShare(sumShare)} · off target`
                              : 'Σ share 100% · balanced'
                            : null}
                        </span>
                        {needsRebalance && !shapeLocked && (
                          <button
                            type="button"
                            onClick={() => rebalanceLegs(r.ccy)}
                            className="rounded border border-amber-700/50 bg-amber-500/10 px-2.5 py-1 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/20"
                          >
                            Rebalance to 100%
                          </button>
                        )}
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[720px] text-left text-[11px]">
                          <thead>
                            <tr className={muted}>
                              <th className="py-0 pb-1.5 pr-3 font-medium">
                                Leg
                              </th>
                              <th className="py-0 pb-1.5 pr-3 font-medium">
                                Settle
                              </th>
                              <th className="py-0 pb-1.5 pr-3 font-medium">
                                Share
                              </th>
                              <th className="py-0 pb-1.5 pr-3 font-medium">
                                Notional
                              </th>
                              <th className="py-0 pb-1.5 pr-3 font-medium">
                                Cumulative H
                              </th>
                              <th className="py-0 pb-1.5 pr-3 font-medium text-emerald-300/70">
                                Implied carry
                              </th>
                              <th className="py-0 pb-1.5 font-medium">
                                Status
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {structLegs.map((leg, i) => {
                              const prev =
                                i > 0 ? structLegs[i - 1]!.hedgeLocalM : 0;
                              const delta = leg.hedgeLocalM - prev;
                              const settle = structLegMonths[i] ?? leg.endMonth;
                              const settleLabel =
                                Math.abs(settle - Math.round(settle)) < 1e-6
                                  ? `M${Math.round(settle)}`
                                  : `t=${settle.toFixed(1)}`;
                              const carry =
                                leg.impliedCarryUsdM ??
                                (prepared?.structure === 'bullet'
                                  ? prepared.impliedCarryUsdM
                                  : undefined);
                              return (
                                <tr
                                  key={`${r.ccy}-prep-${leg.index}`}
                                  className={`border-t ${border}/80`}
                                >
                                  <td className="py-1.5 pr-3">
                                    <span className="inline-flex items-center gap-1.5">
                                      <span className="rounded bg-violet-500/20 px-1 py-0.5 text-[9px] font-semibold text-violet-200">
                                        FWD
                                      </span>
                                      <span className="font-mono text-slate-100">
                                        {previewIsStrip ? `L${i + 1}` : leg.label}
                                      </span>
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-3">
                                    {previewIsStrip ? (
                                      <span className="inline-flex items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            legSettleStep(r.ccy, i, -1)
                                          }
                                          disabled={shapeLocked}
                                          title={shapeLockedReason ?? undefined}
                                          className="flex h-[18px] w-[18px] items-center justify-center rounded border border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                          −
                                        </button>
                                        <span className="w-10 text-center font-mono text-amber-200/90">
                                          {settleLabel}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            legSettleStep(r.ccy, i, 1)
                                          }
                                          disabled={shapeLocked}
                                          title={shapeLockedReason ?? undefined}
                                          className="flex h-[18px] w-[18px] items-center justify-center rounded border border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                          +
                                        </button>
                                      </span>
                                    ) : (
                                      <span className="font-mono text-amber-200/90">
                                        {settleLabel}
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3">
                                    {previewIsStrip ? (
                                      <span className="inline-flex items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            legShareStep(r.ccy, i, -1)
                                          }
                                          disabled={shapeLocked}
                                          title={shapeLockedReason ?? undefined}
                                          className="flex h-[18px] w-[18px] items-center justify-center rounded border border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                          −
                                        </button>
                                        <span className="w-9 text-center font-mono text-slate-100">
                                          {fmtShare(cfg.sh[i] ?? 0)}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            legShareStep(r.ccy, i, 1)
                                          }
                                          disabled={shapeLocked}
                                          title={shapeLockedReason ?? undefined}
                                          className="flex h-[18px] w-[18px] items-center justify-center rounded border border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                          +
                                        </button>
                                      </span>
                                    ) : (
                                      <span className="font-mono text-slate-100">
                                        100%
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono font-semibold text-emerald-300">
                                    {fmtLocal(delta, r.ccy)}
                                  </td>
                                  <td className={`py-1.5 pr-3 font-mono ${muted}`}>
                                    {fmtLocal(leg.hedgeLocalM, r.ccy)}
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono text-emerald-300/90">
                                    {carry == null
                                      ? '—'
                                      : fmtVarK(Math.abs(carry)).replace(
                                          '$',
                                          carry >= 0 ? '+$' : '−$',
                                        )}
                                  </td>
                                  <td className={`py-1.5 text-[10px] ${muted}`}>
                                    {(() => {
                                      // This table is the NEXT strip. Strip
                                      // tickets already on the book are the
                                      // previous one and match draft rows by
                                      // stripEdgeIndex, which would stamp a
                                      // fresh draft leg FILLED — keep them out.
                                      //
                                      // Deliberately `isStrip`, not
                                      // `previewIsStrip`: on a strip card the
                                      // pre-filter above leaves no stripId
                                      // ticket for the strip branch to match,
                                      // so this returns null and the row shows
                                      // its staged label. Passing
                                      // `previewIsStrip` would take the bullet
                                      // branch on an unwind and badge the
                                      // buy-back row with an unrelated booked
                                      // bullet's FILLED state.
                                      const bookedLeg = bookedForLegIndex(
                                        bookedForCcy.filter(t => !t.stripId),
                                        isStrip,
                                        i,
                                      );
                                      if (bookedLeg) {
                                        const state = hedgeTicketExecutionState(
                                          bookedLeg,
                                          Date.now(),
                                        );
                                        return (
                                          <span
                                            className={LEG_STATE_CLASS[state]}
                                            title={
                                              state === 'HELD'
                                                ? OVER_AUTOMATED_LIMIT_NOTE
                                                : 'Execution state of the order booked for this leg'
                                            }
                                          >
                                            {state}
                                          </span>
                                        );
                                      }
                                      return prepared
                                        ? [
                                            prepared.preparedFor === 'carry'
                                              ? 'Cash Carry'
                                              : prepared.preparedFor === 'liquidity'
                                                ? 'Liquidity'
                                                : prepared.preparedFor === 'var'
                                                  ? 'FX Risk'
                                                  : 'prepared',
                                            regimeLabel,
                                          ]
                                            .filter(Boolean)
                                            .join(' · ')
                                        : 'draft';
                                    })()}
                                  </td>
                                </tr>
                              );
                            })}
                            {blotterTickets.map(t => {
                              const cancelled = t.status === 'cancelled';
                              const scheduled = t.status === 'scheduled';
                              return (
                                <tr
                                  key={t.id}
                                  onClick={() => viewOrder(t)}
                                  title="View this order — parameters and tape"
                                  className={`border-t ${border}/80 bg-emerald-500/[0.04] cursor-pointer hover:bg-emerald-500/[0.08]`}
                                >
                                  <td className="py-1.5 pr-3">
                                    <span className="inline-flex items-center gap-1.5">
                                      {t.instrument === 'option' ? (
                                        <span
                                          className="inline-flex items-center gap-1 text-violet-300"
                                          title="Option"
                                        >
                                          <DeskIcon
                                            name="instr-option"
                                            className="h-[18px] w-[18px]"
                                            strokeWidth={1.8}
                                          />
                                          <span className="rounded bg-violet-500/20 px-1 py-0.5 text-[9px] font-semibold text-violet-200">
                                            OPTION
                                          </span>
                                        </span>
                                      ) : (
                                        <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold text-emerald-300">
                                          {t.instrument.toUpperCase()}
                                        </span>
                                      )}
                                      {/* Order type, not order state — a filled limit order was still a limit order. */}
                                      {t.limitRate != null ? (
                                        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[9px] font-semibold text-amber-200">
                                          LIMIT ORDER
                                        </span>
                                      ) : null}
                                      <span className="font-mono text-slate-100">
                                        {ticketLabel(t)}
                                      </span>
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono text-amber-200/90">
                                    {t.maturityLabel ?? t.maturity ?? '—'}
                                  </td>
                                  <td className={`py-1.5 pr-3 font-mono ${muted}`}>
                                    {ticketLimitLevelLabel(t)}
                                  </td>
                                  {/* nowrap: this caption is one fact. Wrapped, its
                                      tail sat on its own line and read as a second
                                      status contradicting the badge beside it. */}
                                  <td className="whitespace-nowrap py-1.5 pr-3 font-mono font-semibold text-emerald-300">
                                    {ticketFillWorkingLabel(t)}
                                  </td>
                                  <td className={`py-1.5 pr-3 font-mono ${muted}`}>
                                    {ticketGoodTillLabel(t)}
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono text-emerald-300/90">
                                    {t.sourcePackage?.impliedCarryUsdM == null
                                      ? '—'
                                      : fmtVarK(
                                          Math.abs(t.sourcePackage.impliedCarryUsdM),
                                        ).replace(
                                          '$',
                                          t.sourcePackage.impliedCarryUsdM >= 0
                                            ? '+$'
                                            : '−$',
                                        )}
                                  </td>
                                  <td className="py-1.5 text-[10px]">
                                    {(() => {
                                      const state = hedgeTicketExecutionState(
                                        t,
                                        Date.now(),
                                      );
                                      const blocked = state === 'HELD';
                                      return (
                                    <span
                                      className={`inline-flex items-center gap-1 ${
                                        cancelled
                                          ? 'text-slate-400'
                                          : blocked
                                            ? 'text-rose-300'
                                            : state === 'WORKING'
                                              ? 'text-amber-300'
                                              : state === 'FILLED'
                                                ? 'text-emerald-300'
                                                : 'text-emerald-300/80'
                                      }`}
                                      title={
                                        blocked
                                          ? OVER_AUTOMATED_LIMIT_NOTE
                                          : state === 'WORKING'
                                            ? t.stripId
                                              ? 'Strip leg working on the tape'
                                              : 'Order working on the tape'
                                            : state === 'FILLED'
                                              ? 'Filled — no longer working'
                                              : undefined
                                      }
                                    >
                                      {state === 'WORKING' && !cancelled ? (
                                        <DeskIcon
                                          name={
                                            t.instrument === 'option'
                                              ? 'instr-option'
                                              : t.stripId
                                                ? 'instr-strip'
                                                : 'status-working'
                                          }
                                          className="h-3 w-3"
                                        />
                                      ) : null}
                                      {cancelled
                                        ? 'CANCELED'
                                        : blocked
                                          ? 'BLOCKED'
                                          : state}
                                    </span>
                                      );
                                    })()}{' '}
                                    {scheduled && t.limitRate != null ? (
                                      <button
                                        type="button"
                                        title="Edit this working order"
                                        onClick={e => {
                                          e.stopPropagation();
                                          editWorkingOrder(t);
                                        }}
                                        aria-label="Edit this working order"
                                        className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded border border-sky-600/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </button>
                                    ) : null}
                                    {cancelled ? (
                                    // Already dead — this clears the row, it
                                    // does not cancel anything. Routing it
                                    // through requestCancellation would
                                    // re-publish a CANCELLED notice and sweep
                                    // strip siblings, filled ones included.
                                    <button
                                      type="button"
                                      title="Clear this cancelled row from the blotter — the order stays on the chart and in the execution log"
                                      onClick={e => {
                                        e.stopPropagation();
                                        dismissTickets([t]);
                                      }}
                                      aria-label="Clear this cancelled row"
                                      className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded border border-slate-600/40 bg-slate-500/10 text-slate-300 hover:bg-slate-500/20"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                    ) : (
                                    <button
                                      type="button"
                                      title={
                                        t.stripId
                                          ? 'Cancel entire rolling strip — restage the structure that was booked'
                                          : 'Cancel this hedge and restage the ticket'
                                      }
                                      onClick={e => {
                                        e.stopPropagation();
                                        requestCancellation(t);
                                      }}
                                      aria-label={t.stripId ? 'Cancel strip' : 'Cancel order'}
                                      className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded border border-rose-600/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {(dismissableTickets.length > 0 || dismissedCount > 0) && (
                        <div className="flex flex-wrap items-center gap-2 text-[10px]">
                          {dismissableTickets.length > 0 && (
                            <button
                              type="button"
                              onClick={() => dismissTickets(dismissableTickets)}
                              title={`Clear ${dismissableTickets.length} cancelled ${r.ccy} ${dismissableTickets.length === 1 ? 'row' : 'rows'} from the blotter — the orders stay on the chart and in the execution log`}
                              className="inline-flex items-center gap-1 rounded border border-slate-600/50 bg-slate-500/10 px-2 py-1 font-semibold text-slate-300 hover:bg-slate-500/20"
                            >
                              <Trash2 className="h-3 w-3" />
                              Clear {dismissableTickets.length} cancelled
                            </button>
                          )}
                          {dismissedCount > 0 && (
                            <button
                              type="button"
                              onClick={() => restoreDismissed(r.ccy)}
                              title={`Show the ${dismissedCount} cleared ${r.ccy} ${dismissedCount === 1 ? 'row' : 'rows'} again`}
                              className="inline-flex items-center gap-1 rounded border border-slate-700/60 px-2 py-1 text-slate-500 hover:text-slate-300"
                            >
                              {dismissedCount} cleared · show
                            </button>
                          )}
                        </div>
                      )}

                      <div className="flex flex-nowrap items-center gap-2 overflow-x-auto">
                        <span className="flex min-w-0 shrink gap-x-3 whitespace-nowrap text-[10px]">
                          <span className={muted}>
                            VaR @ Δ1{' '}
                            <span className="font-mono text-slate-300">
                              {fmtVarK(r.varBeforeUsdM)}
                            </span>
                          </span>
                          <span className={muted}>
                            Δ{' '}
                            <span className="font-mono text-amber-300">
                              {r.delta.toFixed(2)}
                            </span>
                          </span>
                          <span className={muted}>
                            Resid{' '}
                            <span className="font-mono text-slate-300">
                              {fmtLocal(r.residualLocalM, r.ccy)}
                            </span>
                          </span>
                          <span className={muted}>
                            VaR{' '}
                            <span className="font-mono font-semibold text-emerald-300">
                              {fmtVarK(r.varAfterUsdM)}
                            </span>
                          </span>
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        {prepared ? (
                          <span
                            className={`rounded border px-2 py-1 text-[10px] font-semibold ${
                              draftDirty
                                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                                : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                            }`}
                            title={
                              draftDirty
                                ? 'Draft changed — Restage to update the package'
                                : 'Staged package — Book commits it to the live book; Reset drops it'
                            }
                          >
                            {draftDirty ? 'Edited' : '✓ Staged'}
                          </span>
                        ) : null}
                        {showStage ? (
                        <button
                          type="button"
                          disabled={flat || Math.abs(structPctFor(r.ccy)) < 1e-9}
                          title={
                            prepared
                              ? 'Restage — write this draft over the staged package'
                              : 'Stage this structure — appears on FX Fwd/Hedge and Liquidity settle preview; Swap near stays booked-only until Book'
                          }
                          onClick={() => stageStructured(r.ccy)}
                          className="rounded-md border border-violet-500/50 bg-violet-500/15 px-2.5 py-1 text-[11px] font-semibold text-violet-200 hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          {prepared ? 'Restage' : 'Stage'}
                        </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={!prepared}
                          title="Reset staged package — Decision and Liquidity drop this CCY"
                          onClick={() => discardPrepared(r.ccy)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2.5 py-1 text-[11px] font-semibold text-slate-400 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <DeskIcon name="action-reset" className="h-3 w-3" />
                          Reset
                        </button>
                        <button
                          type="button"
                          disabled={!canBook}
                          title={
                            !canBook
                              ? Math.abs(atFull.residual) > 1e-9
                                ? 'Nothing to book — opposite-sign tickets use the hedge budget, so leftover cannot add and covering is not an overhedge'
                                : 'Nothing left to book — covering already matches Target × %'
                              : isUnwind
                                ? `Buy back overhedge ${fmtLocal(hedgeTargetTradeM, r.ccy)} — keeps the filled strip`
                                : stripBooked
                                  ? 'Open the trading ticket — books the leftover clip beside the live strip'
                                  : prepared
                                    ? 'Open the trading ticket — books the unbooked clip; live tickets stay'
                                    : 'Open the trading ticket — pick instrument, price, confirm'
                          }
                          onClick={() => openBookModal(r.ccy)}
                          className="inline-flex items-center gap-1 rounded-md border border-emerald-600/60 bg-emerald-500/20 px-2.5 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <DeskIcon name="action-book" className="h-3 w-3" />
                          Book
                        </button>
                        </span>
                      </div>
                      </div>
                    </div>
                  )}
                </Fragment>
              );
            })}
        {summary.rows.length > 1 && (
          <div
            className={`${structRowGrid} bg-slate-900/40 py-1.5`}
            title="FCY amounts don't sum across currencies — VaR columns are USD totals"
          >
            <span className="text-[11px] font-semibold text-violet-200">
              All
            </span>
            <span />
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span className="text-right font-mono text-[11px] font-semibold tabular-nums text-amber-300">
              {fmtVarK(exposureOverviewTotals.varStock)}
            </span>
            <span className="text-right font-mono text-[11px] font-semibold tabular-nums text-emerald-300">
              {fmtVarK(exposureOverviewTotals.varTotal)}
            </span>
            <span />
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span className="text-right font-mono text-[11px] font-semibold tabular-nums text-emerald-300">
              {fmtVarK(summary.totalVarAfterUsdM)}
            </span>
            <span
              className="text-right font-mono text-[11px] font-semibold tabular-nums text-emerald-300"
              title="Σ staged FX-hedge FWD-points carry — same $M as Liquidity Hedge Carry"
            >
              {Object.keys(stagedCarryByCcyUsdM).length
                ? fmtVarK(stagedCarryUsdMTotal)
                : '—'}
            </span>
            <span />
          </div>
        )}
        </div>
      </section>

      <LiquiditySwapDecision
        rows={fcyComputed ?? []}
        r_USD={r_USD ?? 0}
        sizingBasis={sizingBasis ?? 'horizon'}
        bookingMode={bookingMode ?? 'rolling'}
        forecastMonths={forecastMonths ?? varSetup.forecastMonths ?? 1}
        onSizingBasisChange={onSizingBasisChange}
        onBookingModeChange={onBookingModeChange}
        preparedByCcy={preparedByCcy}
        embedded={embedded}
      />

      <OrgBookedTradesPush
        tickets={booked}
        cancelled={cancelledNotices}
        sandboxTaskId={journalTaskId}
        onOpenBlotter={() => setHedgeTab('blotter')}
        onEditOrder={editWorkingOrder}
        onCancelOrder={requestCancellation}
      />

      {ocoCancelEvents.length > 0 && (
        <div className="fixed bottom-4 left-4 z-40 flex flex-col gap-1.5">
          {ocoCancelEvents.slice(0, 3).map(e => (
            <div
              key={e.id}
              className="flex items-center gap-2 rounded-md border border-amber-600/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200 shadow-lg"
            >
              <span>
                {e.ccy} {e.role === 'takeProfit' ? 'Take Profit' : e.role === 'stopLoss' ? 'Stop Loss' : 'order'} auto-cancelled — the other OCO leg filled
              </span>
              <button
                type="button"
                onClick={() =>
                  setOcoCancelEvents(prev => prev.filter(x => x.id !== e.id))
                }
                className="ml-1 rounded px-1 text-amber-300/70 hover:bg-amber-500/20 hover:text-amber-200"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <TradeTicketPanel
          key={ticketPanelKey ?? `tape:${draft.ocoGroupId ?? draft.id}`}
          ticket={draft}
          siblingOrder={ocoSiblingOf(booked, draft)}
          occupyingStripTickets={booked.filter(
            t => t.ccy === draft.ccy && Boolean(t.stripId),
          )}
          relatedStripTickets={((): HedgeTicket[] => {
            // Which single strip this panel is about. The draft's own when
            // it is on the book; otherwise the CCY's most recently active
            // one (latest fill, else latest placement decoded from the id).
            const draftStripIdOnBook =
              draft.stripId != null
              && booked.some(p => p.stripId === draft.stripId)
                ? draft.stripId
                : null;
            let latestStripIdForCcy: string | null = null;
            if (draftStripIdOnBook == null) {
              let best = -1;
              for (const t of booked) {
                if (t.ccy !== draft.ccy || !t.stripId) continue;
                if (t.status === 'cancelled') continue;
                const at =
                  (t.filledAtMs != null && Number.isFinite(t.filledAtMs)
                    ? t.filledAtMs
                    : null)
                  ?? ticketPlacedAtMs(t.id)
                  ?? 0;
                if (at > best) {
                  best = at;
                  latestStripIdForCcy = t.stripId;
                }
              }
            }
            const peers = booked.filter(t => {
              if (t.ccy !== draft.ccy || !t.stripId) return false;
              // Exactly ONE strip's tickets, never a mixture. The draft's
              // own strip when it is on the book; otherwise the CCY's most
              // recent one, because a Book compose mints a fresh stripId
              // (composeDecisionBookTicket) that matches nothing — which
              // used to hand the panel an empty peer list so every leg
              // opened unexecuted, while a bullet open (no stripId minted)
              // skipped the gate and resolved correctly. Supplying every
              // strip for the CCY fixed that but replaced it with a worse
              // failure: three EUR strips at once, so rows matched peers
              // from a different ladder entirely.
              // Executed legs are supplied even to a fresh Book overlay:
              // under one-strip-per-CCY those slots really are consumed
              // (the matcher refuses a rest on an executed slot and the
              // book merge collapses a re-fill into the existing ticket),
              // so hiding them showed "active" legs whose clicks went
              // nowhere. Reopening Book greys and locks executed slots;
              // only genuinely free slots trade.
              return t.stripId === (draftStripIdOnBook ?? latestStripIdForCcy);
            });
            // ...but a finished strip consumes nothing. A Book compose mints
            // a stripId that is on nothing, so the fallback above hands it
            // the currency's previous ladder — and `legPeersAtEdge` matches
            // those by edge index, marking every row of the NEW ladder as
            // already executed at the old one's prices. Once that strip has
            // no free slot and nothing working, the desk is starting the next
            // ladder, not resuming this one, so it gets a clean sheet. A
            // part-worked strip is still supplied: its free slots are exactly
            // what Book is for.
            if (draftStripIdOnBook == null && stripFullyExecuted(peers)) {
              return [];
            }
            // A new Analytics remaining ladder (6-leg leftover vs the
            // executed 5-leg stamp) is not a resume of that strip. Feeding
            // those peers would pin Book to the old tenors by edge index.
            if (draftStripIdOnBook == null) {
              const composed =
                draft.sourcePackage
                ?? livePreparedHedge(allPrepared[draft.ccy]);
              const bookedStamp = peers.find(
                t => t.sourcePackage?.structure === 'strip',
              )?.sourcePackage;
              if (
                isPreparedStrip(composed)
                && isPreparedStrip(bookedStamp)
                && !stripSchedulesAgree(composed, bookedStamp)
              ) {
                return [];
              }
            }
            return peers;
          })()}
          bookSession={Boolean(ticketPanelKey?.startsWith('book:'))}
          overlayOpenedAtMs={overlayOpenedAtMs}
          tapeHistoryLoading={tapeHistoryLoading}
          initialTapeTrail={(() => {
            if (
              ticketPanelKey?.startsWith('book:')
              && isFreeBookComposeTicket(draft)
            ) {
              return [];
            }
            const own = tapeHistoryRef.current.get(tapeQuoteKey(draft)) ?? [];
            // A SPOT-REFERENCED order rests and fills on spot, so tapeQuoteKey
            // sends it to the currency's spot key — which IS populated, so the
            // `own.length > 0` shortcut below returned the raw spot series and
            // the derivation further down was never reached (and could not
            // help anyway: tapeInstrument returns 'spot' for these). The chart
            // then opened in spot convention under a forward blotter row. The
            // shift comes from the leg's stripLegPoints, not the stamps: a
            // resting spot-referenced order's fxOutright holds its limit until
            // it fills, so stamps would derive the wrong points.
            const spotRefShift = spotReferencedLegShift(draft);
            if (spotRefShift != null) {
              const spotHist =
                tapeHistoryRef.current.get(
                  `${draft.ccy.toUpperCase()}|spot`,
                ) ?? [];
              if (spotHist.length > 0) {
                return spotHist.map(pt => ({
                  ...pt,
                  bid: pt.bid + spotRefShift,
                  mid: pt.mid + spotRefShift,
                  ask: pt.ask + spotRefShift,
                }));
              }
            }
            if (own.length > 0) return own;
            // ONE recorded tape per currency: a live-executed FORWARD trade
            // has no stored series under its own key (forward keys are
            // derived, not persisted) — its record is the SPOT series
            // shifted by the stamped points (fxOutright − fxSpot). Without
            // this, market-filled forwards opened with no tape at all.
            if (tapeInstrument(draft) !== 'spot') {
              const stampedSpot = draft.ipaQuote?.fxSpot;
              const stampedOutright = draft.ipaQuote?.fxOutright;
              if (
                stampedSpot != null && stampedSpot > 0
                && stampedOutright != null && stampedOutright > 0
              ) {
                const spotHist =
                  tapeHistoryRef.current.get(
                    `${draft.ccy.toUpperCase()}|spot`,
                  ) ?? [];
                const shift = stampedOutright - stampedSpot;
                return spotHist.map(pt => ({
                  ...pt,
                  bid: pt.bid + shift,
                  mid: pt.mid + shift,
                  ask: pt.ask + shift,
                }));
              }
            }
            return own;
          })()}
          legTapeHistory={
            // The canonical spot record is ALWAYS supplied: every leg's
            // chart derives from it (spot history + that leg's stamped
            // points), so gating the whole prop on draft.stripId left a
            // strip being composed — and a just-executed strip whose draft
            // has not yet been re-derived with its stripId — seeding empty
            // on every leg-tile click until the booking round-trip landed.
            // Strip peers' own keys are added when there is a strip.
            Object.fromEntries([
              ...(draft.stripId
                ? booked
                    .filter(t => t.stripId === draft.stripId)
                    .map(t => {
                      const key = tapeQuoteKey(t);
                      return [key, tapeHistoryRef.current.get(key) ?? []] as const;
                    })
                : []),
              ((): readonly [string, TapeHistoryPoint[]] => {
                const spotKey = `${draft.ccy.toUpperCase()}|spot`;
                return [
                  spotKey,
                  tapeHistoryRef.current.get(spotKey) ?? [],
                ] as const;
              })(),
            ])
          }
          execEvents={monitorFeed}
          varSetup={varSetupWithLineUncertainty(
            varSetup,
            draft.ccy,
            forecastProfile,
          )}
          prepared={preparedForTicketFromCard(draft)}
          pathExposure={draftPathExposure}
          onStripShapeChange={pkg => saveStripShapeFromTicket(draft.ccy, pkg)}
          decisionStructure={structureFor(draft.ccy)}
          marketRates={resolveMarketRatesForCcy(
            marketRatesByCcy,
            draft.ccy,
            ratesScopeId,
          )}
          onClose={() => {
            setDraft(null);
            setEditingOriginal(null);
            setViewOnly(false);
            setTicketPanelKey(null);
            setOverlayOpenedAtMs(null);
          }}
          onConfirm={confirmBook}
          onLeaveOrder={leaveRestingOrder}
          readOnly={viewOnly}
          onEditWorkingOrder={editWorkingOrder}
          onCancelWorkingOrder={cancelWorkingOrder}
          onCancelOrder={
            viewOnly
              ? () => {
                  requestCancellation(draft);
                  setDraft(null);
                  setViewOnly(false);
                }
              : undefined
          }
        />
      )}

      {chartCcy &&
        chartRow &&
        chartBar &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="decision-path-title"
            onClick={e => {
              if (e.target === e.currentTarget) closePathChart();
            }}
          >
            <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
              <div className="sticky top-0 z-30 shrink-0 border-b border-slate-800 bg-slate-900 px-4 pb-3 pt-4 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.75)]">
                <HedgeStagingHeader
                  titleId="decision-path-title"
                  title={`${chartCcy} — exposure path vs hedge`}
                  subtitle={
                    <>
                      Selected regime:{' '}
                      <span className="font-semibold text-violet-200">
                        {pathBasis === 'cash'
                          ? 'Cash (stock)'
                          : pathBasis === 'varNeutral'
                            ? 'VaR-neutral'
                            : 'Target (Total)'}
                      </span>
                    </>
                  }
                  chips={
                    pathSummaryMetrics
                      ? chipsFromPathSummary(pathSummaryMetrics)
                      : undefined
                  }
                  isPrebooked={Boolean(chartCcy && releasedLive(chartCcy))}
                  draftDirty={Boolean(
                    chartCcy
                    && releasedLive(chartCcy)
                    && pathSummaryMetrics
                    && pathChartDraftDirty(
                      releasedLive(chartCcy)!,
                      pathSummaryMetrics,
                    ),
                  )}
                  prepareAction={
                    pathPrepareAction
                    ?? {
                        label: 'Stage hedging strategy',
                        title:
                          'Stage this path — then Book under this CCY',
                        disabled: false,
                        run: () =>
                          bookHedgeProfileFromChart({
                            structure: effectiveStructure,
                            basis: pathBasis,
                            edges: [],
                            bulletSettleMonths:
                              pathSummaryMetrics?.settleMonths,
                            coverPct: chartRow.hedgeRatio,
                          }),
                      }
                  }
                  onReset={
                    chartCcy && preparedByCcy[chartCcy]
                      ? () => discardPrepared(chartCcy)
                      : undefined
                  }
                  onClose={closePathChart}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
              <ExposureHedgePathChart
                key={`${chartRow.ccy}-${hedgeSizingSetup.horizon}-${varSetup.forecastMonths}-${varSetup.exposureBasis}-${hasRollingStripForCcy(booked, chartRow.ccy) ? 'strip' : 'open'}`}
                ccy={chartRow.ccy}
                stockM={chartBar.stockNetM}
                monthlyFlowM={
                  varSetup.forecastMonths > 0 &&
                  Math.abs(chartBar.flowM) > 1e-15
                    ? chartBar.flowM
                    : 0
                }
                monthlyFlows={monthlyFlowsByCcy[chartRow.ccy]}
                setup={varSetupWithLineUncertainty(
                  varSetup,
                  chartRow.ccy,
                  forecastProfile,
                )}
                marketRates={resolveMarketRatesForCcy(
                  marketRatesByCcy,
                  chartRow.ccy,
                  ratesScopeId,
                )}
                appliedHedgeLocalM={chartRow.hedgeNotionalLocalM}
                hedgeRatio={chartRow.hedgeRatio}
                equalVarHedgeLocalM={chartRow.equalVarHedgeLocalM}
                endExposureM={chartRow.openExposureLocalM}
                selectedBasis={pathBasis}
                onSelectedBasisChange={setPathBasis}
                onApplyBasis={applyPathBasis}
                onBookHedgeProfile={bookHedgeProfileFromChart}
                summaryMetricsPlacement="none"
                onSummaryMetricsChange={setPathSummaryMetrics}
                prepareCtaPlacement="external"
                onPrepareActionChange={setPathPrepareAction}
                stripAlreadyBooked={hasRollingStripForCcy(
                  booked,
                  chartRow.ccy,
                )}
                hedgeStructure={
                  isPreparedStrip(releasedLive(chartRow.ccy))
                    ? 'strip'
                    : hedgeStructure
                }
                onHedgeStructureChange={setHedgeStructure}
                stripLegCount={
                  isPreparedStrip(releasedLive(chartRow.ccy))
                    ? releasedLive(chartRow.ccy)!.legs.length
                    : null
                }
                scheduleEndMonths={stripScheduleEndsFromPrepared(
                  releasedLive(chartRow.ccy),
                )}
                scheduleHedgeWeights={stripScheduleWeightsFromPrepared(
                  releasedLive(chartRow.ccy),
                )}
              />
              </div>
            </div>
          </div>,
          document.body,
        )}
      </>
      )}
    </div>
  );
}

function Stat({
  label, value, hint, embedded, accent,
}: {
  label: string;
  value: string;
  hint: string;
  embedded: boolean;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        embedded
          ? accent
            ? 'border-emerald-600/40 bg-emerald-500/10'
            : 'border-slate-800 bg-slate-950/50'
          : 'border-gray-200 bg-gray-50'
      }`}
    >
      <div className={`text-[11px] ${embedded ? 'text-slate-500' : 'text-gray-500'}`}>{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${accent ? 'text-emerald-300' : ''}`}>
        {value}
      </div>
      <div className={`text-[10px] ${embedded ? 'text-slate-600' : 'text-gray-400'}`}>{hint}</div>
    </div>
  );
}
