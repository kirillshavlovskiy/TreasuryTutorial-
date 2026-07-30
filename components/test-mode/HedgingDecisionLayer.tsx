'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ExposureHedgePathChart } from '@/components/test-mode/ExposureHedgePathChart';
import {
  DEFAULT_FORECAST_PROFILE,
  monthlyFlowSeriesLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import type { RowState } from '@/lib/fx-buffer';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  hedgeBasisNotionalLocalM,
  hedgeRatioForNumber,
  inferHedgePathBasis,
  resolveChartMonthlyFlows,
  type HedgePathBasisId,
} from '@/lib/test-mode/exposure-hedge-path';
import {
  buildHedgeVarSummary,
  isLiveHedgeTicket,
  newHedgeTicketId,
  proposeBookHedge,
  type HedgeInstrument,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';
import {
  buildRollingHedgeEdges,
  hasRollingStripForCcy,
  mergeRollingStripIntoBook,
  needsRollingHedges,
  proposeRollingHedgeTickets,
  removeHedgeTicketOrStrip,
  type RollingHedgeEdge,
} from '@/lib/test-mode/rolling-hedge';
import {
  DEFAULT_VAR_SETUP,
  computeAnalyticsVarUsdM,
  computeParametricVarUsdM,
  horizonMonths,
  VAR_EXPOSURE_OPTIONS,
  VAR_HORIZON_OPTIONS,
  type VarExposureBasis,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

const HEDGE_STEP_PCT = 10;

const BOOK_INSTRUMENTS: { id: HedgeInstrument; label: string }[] = [
  { id: 'spot', label: 'Spot' },
  { id: 'forward', label: 'Forward' },
  { id: 'option', label: 'Option' },
];

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

/** Clickable Cash / VaR-neutral / Target notional — applies that size as Hedge N. */
function ExposureApplyButton({
  valueLocalM,
  ccy,
  label,
  varUsdM,
  emphasize,
  selected,
  disabled,
  onApply,
}: {
  valueLocalM: number;
  ccy: string;
  label: string;
  varUsdM: number;
  emphasize: boolean;
  /** Currently applied Decision regime for this CCY. */
  selected: boolean;
  disabled: boolean;
  onApply: () => void;
}) {
  const empty = Math.abs(valueLocalM) < 1e-9;
  const long = valueLocalM >= 0;
  return (
    <button
      type="button"
      disabled={disabled || empty}
      onClick={onApply}
      aria-label={`Apply ${label} hedge ${fmtLocal(valueLocalM, ccy)}`}
      aria-pressed={selected}
      title={
        selected
          ? `Selected regime · ${label} · ${fmtLocal(valueLocalM, ccy)}`
          : `Click → apply ${label} as Hedge N · ${fmtLocal(valueLocalM, ccy)} · ${fmtVarK(varUsdM)}`
      }
      className={`group w-full cursor-pointer rounded-md border px-1.5 py-1 text-left font-mono transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        selected
          ? 'border-violet-400 bg-violet-500/25 text-violet-100 ring-2 ring-violet-400/80 font-semibold shadow-[0_0_0_1px_rgba(167,139,250,0.5)]'
          : empty
            ? 'border-transparent text-slate-500'
            : long
              ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300 hover:border-emerald-400 hover:bg-emerald-500/25'
              : 'border-rose-500/60 bg-rose-500/10 text-rose-300 hover:border-rose-400 hover:bg-rose-500/25'
      }${emphasize && !selected ? ' font-semibold ring-1 ring-sky-400/40' : ''}`}
    >
      <span className="block text-[9px] font-sans font-semibold uppercase tracking-wide opacity-80">
        {label}
        {selected ? ' · on' : ''}
      </span>
      <span className="underline decoration-dotted decoration-current/40 underline-offset-2 group-hover:decoration-solid">
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
  const side = t.amountLocalM >= 0 ? 'SELL' : 'BUY';
  const amt = fmtLocal(-t.amountLocalM, t.ccy);
  const tenor = t.maturityLabel ?? t.maturity;
  const base =
    t.instrument === 'spot'
      ? `${side} ${t.ccy} spot ${amt}`
      : t.instrument === 'option'
        ? `${side} ${t.ccy} opt ${tenor ?? ''} ${amt}`.replace(/\s+/g, ' ').trim()
        : `${side} ${t.ccy} fwd ${tenor ?? ''} ${amt}`.replace(/\s+/g, ' ').trim();
  return t.entityName ? `${base} · ${t.entityName}` : base;
}

interface HedgingDecisionLayerProps {
  risk: CurrencyRiskRow[];
  embedded?: boolean;
  title?: string;
  hedgeRatios?: Record<string, number>;
  onHedgeRatiosChange?: (ratios: Record<string, number>) => void;
  /** Booked hedge tickets — shared with Live Ladder for VaR recalculation. */
  bookedHedges?: HedgeTicket[];
  onBookedHedgesChange?: (tickets: HedgeTicket[]) => void;
  varSetup?: VarSetup;
  onBookHedge?: (ticket: HedgeTicket) => void;
  bookRows?: RowState[];
  forecastProfile?: ForecastProfileState;
}

/**
 * Decision layer — start at delta = 1 (unhedged), add hedge notional,
 * and read per-currency VaR before / after on the consolidated book.
 */
export function HedgingDecisionLayer({
  risk,
  embedded = true,
  title = 'Decision layer — Hedging (Δ → VaR)',
  hedgeRatios: controlledRatios,
  onHedgeRatiosChange,
  bookedHedges: controlledBooked,
  onBookedHedgesChange,
  varSetup = DEFAULT_VAR_SETUP,
  onBookHedge,
  bookRows,
  forecastProfile = DEFAULT_FORECAST_PROFILE,
}: HedgingDecisionLayerProps) {
  const [localRatios, setLocalRatios] = useState<Record<string, number>>({});
  const [localBooked, setLocalBooked] = useState<HedgeTicket[]>([]);
  const [draft, setDraft] = useState<HedgeTicket | null>(null);
  const [chartCcy, setChartCcy] = useState<string | null>(null);
  const [pathBasis, setPathBasis] = useState<HedgePathBasisId>('totalExpected');
  const ratios = controlledRatios ?? localRatios;
  const booked = controlledBooked ?? localBooked;
  const setRatios = (next: Record<string, number>) => {
    if (onHedgeRatiosChange) onHedgeRatiosChange(next);
    else setLocalRatios(next);
  };
  const setBooked = (next: HedgeTicket[]) => {
    if (onBookedHedgesChange) onBookedHedgesChange(next);
    else setLocalBooked(next);
  };

  const monthlyFlowsByCcy = useMemo(() => {
    const out: Record<string, number[]> = {};
    const T = varSetup.forecastMonths;
    if (T <= 0) return out;
    const rowsByCcy = new Map((bookRows ?? []).map(r => [r.ccy, r]));
    for (const { bar } of risk) {
      if (bar.ccy === 'USD') continue;
      const row = rowsByCcy.get(bar.ccy);
      if (!row) continue;
      out[bar.ccy] = monthlyFlowSeriesLocalM(row, T, forecastProfile);
    }
    return out;
  }, [bookRows, forecastProfile, risk, varSetup.forecastMonths]);

  const summary = useMemo(
    () => buildHedgeVarSummary(risk, ratios, varSetup, booked, monthlyFlowsByCcy),
    [risk, ratios, varSetup, booked, monthlyFlowsByCcy],
  );

  const riskByCcy = useMemo(() => {
    const m = new Map<string, CurrencyRiskRow>();
    for (const r of risk) m.set(r.bar.ccy, r);
    return m;
  }, [risk]);

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

  /**
   * Click Cash / VaR-neutral / Total → % of Target.
   * Cash = stock/Target · VaR-neutral = Equal-VaR/Target · Total = 100%.
   */
  const applyTargetNotional = (
    ccy: string,
    targetLocalM: number,
    basis: HedgePathBasisId,
  ) => {
    const r = summary.rows.find(row => row.ccy === ccy);
    if (!r || Math.abs(r.targetHedgeLocalM) < 1e-9) return;
    setPathBasis(basis);
    setRatios({
      ...ratios,
      [ccy]: Math.min(
        1,
        hedgeRatioForNumber(targetLocalM, r.targetHedgeLocalM),
      ),
    });
  };

  const openPathChart = (ccy: string) => {
    const r = summary.rows.find(row => row.ccy === ccy);
    if (!r) return;
    const inferred =
      Math.abs(r.hedgeNotionalLocalM) > 1e-9
        ? inferHedgePathBasis(
            r.hedgeNotionalLocalM,
            r.stockHedgeLocalM,
            r.targetHedgeLocalM,
            r.equalVarHedgeLocalM,
          )
        : needsRollingHedges(varSetup)
          ? 'totalExpected'
          : 'varNeutral';
    setPathBasis(inferred);
    setChartCcy(ccy);
  };

  const closePathChart = () => setChartCcy(null);

  const chartRow = chartCcy
    ? summary.rows.find(r => r.ccy === chartCcy)
    : undefined;
  const chartBar = chartCcy
    ? risk.find(r => r.bar.ccy === chartCcy)?.bar
    : undefined;

  const applyPathBasis = (basis: HedgePathBasisId) => {
    if (!chartRow || !chartBar) return;
    setPathBasis(basis);
    const flowM =
      varSetup.forecastMonths > 0 && Math.abs(chartBar.flowM) > 1e-15
        ? chartBar.flowM
        : 0;
    const { startM, endM, flows } = resolveChartMonthlyFlows(
      chartBar.stockNetM,
      flowM,
      varSetup,
      monthlyFlowsByCcy[chartRow.ccy],
    );
    const sizing =
      basis === 'cash'
        ? 'stockStart'
        : basis === 'totalExpected'
          ? 'windowEnd'
          : 'varNeutral';
    const target =
      needsRollingHedges(varSetup) &&
      (basis === 'cash' ||
        basis === 'totalExpected' ||
        basis === 'varNeutral')
        ? buildRollingHedgeEdges(startM, flows, varSetup, sizing)[0]
            ?.hedgeLocalM ?? chartRow.equalVarHedgeLocalM
        : hedgeBasisNotionalLocalM(
            basis,
            startM,
            endM,
            chartRow.equalVarHedgeLocalM,
          );
    const target100 = Math.abs(chartRow.targetHedgeLocalM);
    const ratio =
      target100 < 1e-12
        ? 0
        : Math.min(1, hedgeRatioForNumber(target, chartRow.targetHedgeLocalM));
    setRatios({ ...ratios, [chartRow.ccy]: ratio });
  };

  const bookRollingStripFromChart = (edges: RollingHedgeEdge[]) => {
    if (!chartRow) return;
    if (hasRollingStripForCcy(booked, chartRow.ccy)) {
      closePathChart();
      return;
    }
    const ticketBasis =
      pathBasis === 'cash'
        ? 'stock'
        : pathBasis === 'totalExpected'
          ? 'totalBuildup'
          : varSetup.exposureBasis === 'stock'
            ? 'simpleAvg'
            : varSetup.exposureBasis;
    const tickets = proposeRollingHedgeTickets(
      chartRow.ccy,
      edges,
      varSetup,
      ticketBasis,
    );
    setBooked(mergeRollingStripIntoBook(booked, tickets, chartRow.ccy));
    setRatios({ ...ratios, [chartRow.ccy]: 0 });
    for (const t of tickets) {
      if (isLiveHedgeTicket(t)) onBookHedge?.(t);
    }
    closePathChart();
  };

  const openBookModal = (ccy: string) => {
    const row = riskByCcy.get(ccy);
    if (!row) return;
    // Book the Decision Hedge N (Target × %), defaulting to full Target.
    const net = summary.rows.find(r => r.ccy === ccy);
    const targetN = net?.targetHedgeLocalM ?? 0;
    if (Math.abs(targetN) < 1e-9) return;
    const ratio = ratios[ccy] ?? 0;
    const bookRatio = ratio > 1e-9 ? ratio : 1;
    const template = proposeBookHedge(row, varSetup.exposureBasis, varSetup);
    const amountLocalM = targetN * bookRatio;
    const ticket: HedgeTicket = {
      ...template,
      amountLocalM,
      varUsdM: computeParametricVarUsdM(amountLocalM, ccy, varSetup),
    };
    if (Math.abs(ticket.amountLocalM) < 1e-9) return;
    setDraft(ticket);
  };

  const confirmBook = (edited: HedgeTicket) => {
    // Each confirm appends a new transaction; incremental hedge % resets on the net book.
    const ticket: HedgeTicket = { ...edited, id: newHedgeTicketId() };
    setBooked([ticket, ...booked]);
    setRatios({ ...ratios, [ticket.ccy]: 0 });
    onBookHedge?.(ticket);
    setDraft(null);
  };

  /** Cancel one ticket, or the whole strip if it belongs to a roll. */
  const requestCancellation = (ticket: HedgeTicket) => {
    setBooked(removeHedgeTicketOrStrip(booked, ticket));
    setRatios({ ...ratios, [ticket.ccy]: 0 });
  };

  const rollingStrip = useMemo(() => {
    if (!needsRollingHedges(varSetup)) return null;
    const eur = risk.find(r => r.bar.ccy === 'EUR') ?? risk[0];
    if (!eur) return null;
    const flowM =
      varSetup.forecastMonths > 0 && Math.abs(eur.bar.flowM) > 1e-15
        ? eur.bar.flowM
        : 0;
    const row = bookRows?.find(r => r.ccy === eur.bar.ccy);
    const custom =
      row && forecastProfile.mode === 'custom'
        ? monthlyFlowSeriesLocalM(row, varSetup.forecastMonths, forecastProfile)
        : undefined;
    const { flows, startM, endM } = resolveChartMonthlyFlows(
      eur.bar.stockNetM,
      flowM,
      varSetup,
      custom,
    );
    const sizing =
      varSetup.exposureBasis === 'stock'
        ? 'stockStart'
        : varSetup.exposureBasis === 'totalBuildup'
          ? 'windowEnd'
          : 'varNeutral';
    const edges = buildRollingHedgeEdges(startM, flows, varSetup, sizing);
    if (edges.length < 2) return null;
    return { ccy: eur.bar.ccy, edges, endM, sizing };
  }, [risk, varSetup, bookRows, forecastProfile]);

  const stripAlreadyBooked =
    rollingStrip != null && hasRollingStripForCcy(booked, rollingStrip.ccy);

  const bookRollingStrip = () => {
    if (!rollingStrip || stripAlreadyBooked) return;
    const ticketBasis =
      rollingStrip.sizing === 'stockStart'
        ? 'stock'
        : rollingStrip.sizing === 'windowEnd'
          ? 'totalBuildup'
          : varSetup.exposureBasis === 'stock'
            ? 'simpleAvg'
            : varSetup.exposureBasis;
    const tickets = proposeRollingHedgeTickets(
      rollingStrip.ccy,
      rollingStrip.edges,
      varSetup,
      ticketBasis,
    );
    setBooked(mergeRollingStripIntoBook(booked, tickets, rollingStrip.ccy));
    setRatios({ ...ratios, [rollingStrip.ccy]: 0 });
    // Only the M0 live leg is a real trade today.
    for (const t of tickets) {
      if (isLiveHedgeTicket(t)) onBookHedge?.(t);
    }
  };

  const shell = embedded
    ? 'rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-200'
    : 'rounded-xl border border-gray-200 bg-white p-5 text-gray-900';
  const muted = embedded ? 'text-slate-500' : 'text-gray-500';
  const head = embedded ? 'text-slate-500' : 'text-gray-500';
  const rowHover = embedded ? 'hover:bg-slate-800/50' : 'hover:bg-gray-50';
  const border = embedded ? 'border-slate-800' : 'border-gray-200';

  return (
    <div className={`space-y-4 ${shell}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className={`mt-0.5 text-xs ${muted}`}>
            Hedge-add % of Target (Total expected): Cash = min · VaR-neutral = mid ·
            Total = 100%. Setup: {varSetup.confidencePct}% · {varSetup.horizon} ·{' '}
            {varSetup.exposureBasis}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {rollingStrip && (
            <button
              type="button"
              onClick={bookRollingStrip}
              disabled={stripAlreadyBooked}
              title={
                stripAlreadyBooked
                  ? 'Strip already on the book — cancel it to rebook'
                  : `Book M0 forward now; ${rollingStrip.edges.length - 1} later roll(s) stay scheduled (VaR ${horizonMonths(varSetup.horizon)}m windows)`
              }
              className="rounded-md border border-violet-500/50 bg-violet-500/20 px-2.5 py-1 text-[11px] font-semibold text-violet-100 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {stripAlreadyBooked
                ? 'Strip booked'
                : `Book M0 + ${rollingStrip.edges.length - 1} scheduled`}
            </button>
          )}
          <button
            type="button"
            onClick={() => hedgeAll(0)}
            className="rounded-md border border-slate-600 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            Unhedged
          </button>
        </div>
      </div>

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

      {rollingStrip && (
        <div className="rounded-lg border border-violet-700/40 bg-violet-950/20 px-3 py-2 text-[11px] text-slate-300">
          <div className="mb-1 font-semibold text-violet-200">
            VaR {horizonMonths(varSetup.horizon)}m &lt; forecast{' '}
            {varSetup.forecastMonths}m — roll hedges for {rollingStrip.ccy}
          </div>
          <p className={`mb-1.5 ${muted}`}>
            Total expected path end {fmtLocal(rollingStrip.endM, rollingStrip.ccy)}.
            Book successive VaR-window forwards from each new stock level:
          </p>
          <div className="flex flex-wrap gap-2 font-mono text-[10px] text-violet-100/90">
            {rollingStrip.edges.map(e => (
              <span
                key={e.index}
                className="rounded border border-violet-700/50 bg-slate-950/40 px-1.5 py-0.5"
              >
                {e.label} → {fmtLocal(e.hedgeLocalM, rollingStrip.ccy)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-xs">
          <thead>
            <tr className={`border-b ${border} ${head}`}>
              <th className="py-2 pr-2 font-medium">CCY</th>
              <th
                className="max-w-[5rem] py-2 pr-2 font-medium leading-tight whitespace-normal"
                title="Click → Cash / stock hedge (min on Target scale). Violet outline = selected."
              >
                Cash (stock)
              </th>
              <th
                className="max-w-[5.5rem] py-2 pr-2 font-medium leading-tight whitespace-normal"
                title="Click → VaR-neutral (Equal-VaR). Violet outline = selected."
              >
                VaR-neutral
              </th>
              <th
                className="max-w-[5.5rem] py-2 pr-2 font-medium leading-tight whitespace-normal"
                title="Click → 100% Target (Total expected). Violet outline = selected."
              >
                Target (Total)
              </th>
              <th className="max-w-[3.5rem] py-2 pr-2 font-medium leading-tight whitespace-normal">
                VaR @ Δ1
              </th>
              <th
                className="max-w-[3.5rem] py-2 pr-2 font-medium leading-tight whitespace-normal"
                title="% of Target (Total expected)"
              >
                Hedge % of Target
              </th>
              <th className="py-2 pr-2 font-medium">Delta</th>
              <th className="py-2 pr-2 font-medium">Residual</th>
              <th className="max-w-[3.5rem] py-2 pr-2 font-medium leading-tight whitespace-normal">
                VaR after
              </th>
              <th className="py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map(r => {
              const riskRow = riskByCcy.get(r.ccy);
              const stockRaw = riskRow?.bar.stockNetM ?? r.stockHedgeLocalM;
              const flowRaw = riskRow?.bar.flowM ?? 0;
              const stockM = r.stockHedgeLocalM;
              const varNeutralM = r.equalVarHedgeLocalM;
              const totalM = r.targetHedgeLocalM;
              // Higher-VaR pick must use the Analytics engine (path ≠ snapshot |E|×σ×√T).
              const flowForVar =
                varSetup.forecastMonths > 0 && Math.abs(flowRaw) > 1e-15 ? flowRaw : 0;
              const varStock = computeAnalyticsVarUsdM(stockRaw, 0, r.ccy, {
                ...varSetup,
                exposureBasis: 'stock',
              });
              const varNeutralUsd = computeParametricVarUsdM(
                varNeutralM,
                r.ccy,
                varSetup,
              );
              const varTotal = computeAnalyticsVarUsdM(stockRaw, flowForVar, r.ccy, {
                ...varSetup,
                exposureBasis: 'totalBuildup',
              });
              const higherBasis: VarExposureBasis =
                varTotal >= varNeutralUsd && varTotal > varStock + 1e-12
                  ? 'totalBuildup'
                  : varNeutralUsd > varStock + 1e-12
                    ? 'simpleAvg'
                    : 'stock';
              // Flat when Target (Total expected) is ~0.
              const flat = Math.abs(totalM) < 1e-9;
              const canBook = !flat;
              const selectedRegime: HedgePathBasisId | null =
                Math.abs(r.hedgeNotionalLocalM) < 1e-9
                  ? null
                  : inferHedgePathBasis(
                      r.hedgeNotionalLocalM,
                      stockM,
                      totalM,
                      varNeutralM,
                    );
              return (
                <tr
                  key={r.ccy}
                  className={`border-b ${border}/80 ${rowHover}${flat ? ' opacity-50' : ''}`}
                >
                  <td className="py-2.5 pr-2 font-semibold align-middle">{r.ccy}</td>
                  <td className="max-w-[4.5rem] py-2.5 pr-2 align-middle">
                    <ExposureApplyButton
                      valueLocalM={stockM}
                      ccy={r.ccy}
                      label="Cash (stock)"
                      varUsdM={varStock}
                      emphasize={higherBasis === 'stock'}
                      selected={selectedRegime === 'cash'}
                      disabled={flat}
                      onApply={() =>
                        applyTargetNotional(r.ccy, stockM, 'cash')
                      }
                    />
                  </td>
                  <td className="max-w-[5.5rem] py-2.5 pr-2 align-middle">
                    <ExposureApplyButton
                      valueLocalM={varNeutralM}
                      ccy={r.ccy}
                      label="VaR-neutral"
                      varUsdM={varNeutralUsd}
                      emphasize={higherBasis === 'simpleAvg'}
                      selected={selectedRegime === 'varNeutral'}
                      disabled={flat || Math.abs(varNeutralM) < 1e-9}
                      onApply={() =>
                        applyTargetNotional(r.ccy, varNeutralM, 'varNeutral')
                      }
                    />
                  </td>
                  <td className="max-w-[5.5rem] py-2.5 pr-2 align-middle">
                    <ExposureApplyButton
                      valueLocalM={totalM}
                      ccy={r.ccy}
                      label="Target (Total)"
                      varUsdM={varTotal}
                      emphasize={higherBasis === 'totalBuildup'}
                      selected={selectedRegime === 'totalExpected'}
                      disabled={flat}
                      onApply={() =>
                        applyTargetNotional(r.ccy, totalM, 'totalExpected')
                      }
                    />
                  </td>
                  <td className="py-2.5 pr-3 font-mono font-semibold align-middle">
                    {fmtVarK(r.varBeforeUsdM)}
                  </td>
                  <td className="py-2.5 pr-3 align-middle">
                    <HedgeRatioControl
                      pct={Math.round(r.hedgeRatio * 100)}
                      notional={fmtLocal(r.hedgeNotionalLocalM, r.ccy)}
                      mutedClass={muted}
                      disabled={flat}
                      onChange={pct => setRatio(r.ccy, pct)}
                    />
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-amber-300 align-middle">
                    {r.delta.toFixed(2)}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-slate-400 align-middle">
                    {fmtLocal(r.residualLocalM, r.ccy)}
                  </td>
                  <td className="py-2.5 pr-3 font-mono font-semibold text-emerald-300 align-middle">
                    {fmtVarK(r.varAfterUsdM)}
                  </td>
                  <td className="py-2.5 align-middle">
                    <div className="flex flex-col gap-1">
                      <button
                        type="button"
                        disabled={flat}
                        title="Open exposure path + residual VaR charts"
                        onClick={() => openPathChart(r.ccy)}
                        className="whitespace-nowrap rounded-md border border-violet-500/50 bg-violet-500/15 px-2.5 py-1.5 text-[11px] font-medium text-violet-200 hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        Path charts
                      </button>
                      <button
                        type="button"
                        disabled={!canBook}
                        title={
                          flat
                            ? 'No net exposure on this Analytics basis'
                            : 'Open book-hedge proposal (auto size & timeline)'
                        }
                        onClick={() => openBookModal(r.ccy)}
                        className="whitespace-nowrap rounded-md border border-sky-600/50 bg-sky-500/10 px-2.5 py-1.5 text-[11px] font-medium text-sky-300 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        Book hedge
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {booked.length > 0 && (
        <div className={`rounded-lg border ${border} px-3 py-2.5`}>
          <div className={`text-[11px] font-medium ${head}`}>
            Booked hedges ·{' '}
            {booked.filter(isLiveHedgeTicket).length} live
            {booked.some(t => !isLiveHedgeTicket(t))
              ? ` · ${booked.filter(t => !isLiveHedgeTicket(t)).length} scheduled`
              : ''}
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {[...booked]
              .sort((a, b) => {
                const ai = isLiveHedgeTicket(a) ? 0 : 1;
                const bi = isLiveHedgeTicket(b) ? 0 : 1;
                if (ai !== bi) return ai - bi;
                return (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0);
              })
              .map(t => {
                const scheduled = !isLiveHedgeTicket(t);
                return (
                  <li
                    key={t.id}
                    className="flex flex-wrap items-center gap-2 font-mono text-[11px]"
                  >
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">
                      {t.instrument.toUpperCase()}
                    </span>
                    {scheduled && (
                      <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
                        PENDING
                      </span>
                    )}
                    <span className={scheduled ? 'text-slate-400' : undefined}>
                      {ticketLabel(t)}
                    </span>
                    <span className={muted}>
                      {scheduled
                        ? 'scheduled roll · not traded yet'
                        : `VaR ${fmtVarK(t.varUsdM)}${t.addressesHigherVar ? ' · higher VaR' : ''}`}
                    </span>
                    <button
                      type="button"
                      title={
                        t.stripId
                          ? 'Cancel entire rolling strip'
                          : 'Cancel this hedge transaction'
                      }
                      onClick={() => requestCancellation(t)}
                      className="ml-auto rounded-md border border-rose-600/40 bg-rose-500/10 px-2 py-1 text-[10px] font-medium text-rose-300 hover:bg-rose-500/20"
                    >
                      {t.stripId ? 'Cancel strip' : 'Request cancellation'}
                    </button>
                  </li>
                );
              })}
          </ul>
        </div>
      )}

      {draft && (
        <BookHedgeModal
          ticket={draft}
          varSetup={varSetup}
          onClose={() => setDraft(null)}
          onConfirm={confirmBook}
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
            <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h4
                    id="decision-path-title"
                    className="text-sm font-semibold text-white"
                  >
                    {chartCcy} — exposure path vs hedge
                  </h4>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    Selected regime:{' '}
                    <span className="font-semibold text-violet-200">
                      {pathBasis === 'cash'
                        ? 'Cash (stock)'
                        : pathBasis === 'varNeutral'
                          ? 'VaR-neutral'
                          : 'Target (Total)'}
                    </span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closePathChart}
                  className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                >
                  Close
                </button>
              </div>
              <ExposureHedgePathChart
                key={`${chartRow.ccy}-${chartRow.hedgeRatio.toFixed(4)}-${chartRow.hedgeNotionalLocalM.toFixed(3)}-${varSetup.horizon}-${varSetup.forecastMonths}-${pathBasis}`}
                ccy={chartRow.ccy}
                stockM={chartBar.stockNetM}
                monthlyFlowM={
                  varSetup.forecastMonths > 0 &&
                  Math.abs(chartBar.flowM) > 1e-15
                    ? chartBar.flowM
                    : 0
                }
                monthlyFlows={monthlyFlowsByCcy[chartRow.ccy]}
                setup={varSetup}
                appliedHedgeLocalM={chartRow.hedgeNotionalLocalM}
                hedgeRatio={chartRow.hedgeRatio}
                equalVarHedgeLocalM={chartRow.equalVarHedgeLocalM}
                endExposureM={chartRow.openExposureLocalM}
                selectedBasis={pathBasis}
                onSelectedBasisChange={setPathBasis}
                onApplyBasis={applyPathBasis}
                onBookRollingStrip={bookRollingStripFromChart}
                stripAlreadyBooked={hasRollingStripForCcy(
                  booked,
                  chartRow.ccy,
                )}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function BookHedgeModal({
  ticket,
  varSetup,
  onClose,
  onConfirm,
}: {
  ticket: HedgeTicket;
  varSetup: VarSetup;
  onClose: () => void;
  onConfirm: (ticket: HedgeTicket) => void;
}) {
  const defaultTenor: VarHorizonId =
    ticket.maturity && VAR_HORIZON_OPTIONS.some(h => h.id === ticket.maturity)
      ? ticket.maturity
      : varSetup.horizon;
  const [instrument, setInstrument] = useState<HedgeInstrument>(ticket.instrument);
  const [tenor, setTenor] = useState<VarHorizonId>(defaultTenor);

  const side = ticket.amountLocalM >= 0 ? 'Sell' : 'Buy';
  const basisLabel =
    VAR_EXPOSURE_OPTIONS.find(o => o.id === ticket.basis)?.label ?? ticket.basis;
  const activeBasisLabel =
    VAR_EXPOSURE_OPTIONS.find(o => o.id === varSetup.exposureBasis)?.label ??
    varSetup.exposureBasis;

  const draftTicket: HedgeTicket = useMemo(() => {
    if (instrument === 'spot') {
      return {
        ...ticket,
        instrument: 'spot',
        maturity: null,
        maturityLabel: null,
      };
    }
    return {
      ...ticket,
      instrument,
      maturity: tenor,
      maturityLabel: tenorLabel(tenor),
    };
  }, [ticket, instrument, tenor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="book-hedge-title"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-100 shadow-2xl">
        <h4 id="book-hedge-title" className="text-base font-semibold text-white">
          Book hedge · {ticket.ccy}
        </h4>
        <p className="mt-1 text-xs text-slate-400">
          Size follows Hedge add % on the Analytics-selected exposure (
          {activeBasisLabel}) · {varSetup.confidencePct}% · {varSetup.horizon}. Choose instrument
          and tenor, then confirm.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Instrument
            </div>
            <div className="flex flex-wrap gap-1.5">
              {BOOK_INSTRUMENTS.map(opt => {
                const on = instrument === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setInstrument(opt.id)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      on
                        ? 'border-sky-500 bg-sky-500/20 text-sky-100'
                        : 'border-slate-700 text-slate-400 hover:border-slate-500'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {instrument !== 'spot' && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Tenor
              </div>
              <div className="flex flex-wrap gap-1.5">
                {VAR_HORIZON_OPTIONS.map(opt => {
                  const on = tenor === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setTenor(opt.id)}
                      className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        on
                          ? 'border-emerald-500 bg-emerald-500/20 text-emerald-100'
                          : 'border-slate-700 text-slate-400 hover:border-slate-500'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <dl className="mt-4 space-y-2.5 text-sm">
          <Row term="Exposure basis" detail={
            <>
              {basisLabel}
              {ticket.addressesHigherVar && (
                <span className="ml-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                  higher VaR
                </span>
              )}
            </>
          } />
          <Row
            term="Timeline"
            detail={
              <span className="font-mono text-xs">
                {instrument === 'spot'
                  ? 'Spot (T+2)'
                  : `${instrument === 'option' ? 'Option' : 'Forward'} · ${tenorLabel(tenor)}`}
              </span>
            }
          />
          <Row
            term="Size (auto)"
            detail={
              <span className="font-mono font-semibold text-emerald-300">
                {side} {fmtLocal(Math.abs(ticket.amountLocalM), ticket.ccy).replace(/^[+−]/, '')}
              </span>
            }
          />
          <Row
            term="Offsets exposure"
            detail={
              <span className="font-mono text-xs text-slate-300">
                {fmtLocal(ticket.amountLocalM, ticket.ccy)}
              </span>
            }
          />
          <Row
            term="VaR addressed"
            detail={<span className="font-mono text-xs">{fmtVarK(ticket.varUsdM)}</span>}
          />
          <Row
            term="Ticket"
            detail={
              <span className="font-mono text-xs text-slate-300">{ticketLabel(draftTicket)}</span>
            }
          />
        </dl>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(draftTicket)}
            className="rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/30"
          >
            Confirm book
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ term, detail }: { term: string; detail: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2">
      <dt className="text-[11px] text-slate-500">{term}</dt>
      <dd className="text-right text-xs text-slate-200">{detail}</dd>
    </div>
  );
}

function HedgeRatioControl({
  pct,
  notional,
  mutedClass,
  onChange,
  disabled = false,
}: {
  pct: number;
  notional: string;
  mutedClass: string;
  onChange: (pct: number) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(pct));
  const dragRef = useRef<{ startX: number; startPct: number; moved: boolean } | null>(null);
  const pctRef = useRef(pct);
  pctRef.current = pct;

  useEffect(() => {
    if (!editing) setDraft(String(pct));
  }, [pct, editing]);

  const commitDraft = () => {
    if (disabled) return;
    const n = Number(draft.replace('%', '').trim());
    if (Number.isFinite(n)) onChange(Math.round(clampPct(n)));
    setEditing(false);
  };

  const startEdit = () => {
    if (disabled) return;
    setDraft(String(pctRef.current));
    setEditing(true);
  };

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (editing || disabled) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startPct: pctRef.current, moved: false };
    },
    [editing, disabled],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      if (Math.abs(dx) >= 3) drag.moved = true;
      if (!drag.moved) return;
      const delta = Math.round(dx / 2);
      onChange(clampPct(drag.startPct + delta));
    },
    [onChange, disabled],
  );

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    dragRef.current = null;
    if (drag && !drag.moved) startEdit();
  }, []);

  return (
    <div className={`flex flex-col gap-1${disabled ? ' opacity-40 grayscale' : ''}`}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          title={disabled ? 'No net exposure to hedge' : `−${HEDGE_STEP_PCT}%`}
          aria-label={`Decrease hedge by ${HEDGE_STEP_PCT} percent`}
          disabled={disabled || pct <= 0}
          onClick={() =>
            onChange(
              pct > MAX_HEDGE_PCT
                ? MAX_HEDGE_PCT
                : Math.max(0, pct - HEDGE_STEP_PCT),
            )
          }
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-30"
        >
          −
        </button>

        {editing ? (
          <input
            autoFocus
            type="text"
            inputMode="numeric"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={e => {
              if (e.key === 'Enter') commitDraft();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="w-14 rounded border border-emerald-600/50 bg-slate-950 px-1 py-0.5 text-center font-mono text-[11px] text-emerald-200 outline-none"
          />
        ) : (
          <div
            role="slider"
            tabIndex={0}
            aria-valuemin={0}
            aria-valuemax={MAX_HEDGE_PCT}
            aria-valuenow={pct}
            aria-label="Hedge percent — drag for custom, click to type, buttons ±10%"
            title="Drag for custom % · click to type · ± steps by 10%"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={e => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                e.preventDefault();
                onChange(
                  pct > MAX_HEDGE_PCT
                    ? MAX_HEDGE_PCT
                    : Math.max(0, pct - HEDGE_STEP_PCT),
                );
              } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                e.preventDefault();
                onChange(clampPct(pct + HEDGE_STEP_PCT));
              } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                startEdit();
              } else if (e.key === 'Home') {
                e.preventDefault();
                onChange(0);
              } else if (e.key === 'End') {
                e.preventDefault();
                onChange(MAX_HEDGE_PCT);
              }
            }}
            className="flex min-w-[3.25rem] cursor-ew-resize select-none items-center justify-center rounded border border-slate-600 bg-slate-950/80 px-2 py-1 font-mono text-[11px] text-emerald-300 hover:border-emerald-500/50"
          >
            {pct}%
          </div>
        )}

        <button
          type="button"
          title={disabled ? 'No net exposure to hedge' : `+${HEDGE_STEP_PCT}%`}
          aria-label={`Increase hedge by ${HEDGE_STEP_PCT} percent`}
          disabled={disabled || pct >= MAX_HEDGE_PCT}
          onClick={() => onChange(clampPct(pct + HEDGE_STEP_PCT))}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-30"
        >
          +
        </button>

        <input
          type="range"
          min={0}
          max={MAX_HEDGE_PCT}
          step={1}
          value={Math.min(MAX_HEDGE_PCT, pct)}
          disabled={disabled}
          onChange={e => onChange(Number(e.target.value))}
          className="ml-1 w-20 accent-emerald-500 disabled:cursor-not-allowed"
          title={
            disabled
              ? 'No net exposure to hedge'
              : `Drag for custom hedge % (0–${MAX_HEDGE_PCT}% of Target / Total expected)`
          }
          aria-label="Hedge percent slider"
        />
      </div>
      <div className={`font-mono text-[11px] ${mutedClass}`}>
        {disabled ? 'flat · 0' : notional}
      </div>
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
