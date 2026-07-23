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
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  bookedNotionalLocalM,
  buildHedgeVarSummary,
  newHedgeTicketId,
  proposeBookHedge,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';
import {
  DEFAULT_VAR_SETUP,
  computeParametricVarUsdM,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

const HEDGE_STEP_PCT = 10;

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

function clampPct(pct: number): number {
  return Math.min(100, Math.max(0, pct));
}

function ticketLabel(t: HedgeTicket): string {
  const side = t.amountLocalM >= 0 ? 'SELL' : 'BUY';
  const amt = fmtLocal(-t.amountLocalM, t.ccy);
  const base =
    t.instrument === 'spot'
      ? `${side} ${t.ccy} spot ${amt}`
      : `${side} ${t.ccy} fwd ${t.maturityLabel ?? t.maturity} ${amt}`;
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
}: HedgingDecisionLayerProps) {
  const [localRatios, setLocalRatios] = useState<Record<string, number>>({});
  const [localBooked, setLocalBooked] = useState<HedgeTicket[]>([]);
  const [draft, setDraft] = useState<HedgeTicket | null>(null);
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

  const summary = useMemo(
    () => buildHedgeVarSummary(risk, ratios, varSetup, booked),
    [risk, ratios, varSetup, booked],
  );

  const riskByCcy = useMemo(() => {
    const m = new Map<string, CurrencyRiskRow>();
    for (const r of risk) m.set(r.bar.ccy, r);
    return m;
  }, [risk]);

  const setRatio = (ccy: string, pct: number) => {
    // Incremental hedge % on the net book (booked tickets stay settled).
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

  const openBookModal = (ccy: string) => {
    const row = riskByCcy.get(ccy);
    if (!row) return;
    // Book remaining net exposure on the Analytics-selected basis (after prior bookings).
    const net = summary.rows.find(r => r.ccy === ccy);
    const remaining = net?.exposureLocalM ?? 0;
    if (Math.abs(remaining) < 1e-9) return;
    const ratio = ratios[ccy] ?? 0;
    const bookRatio = ratio > 1e-9 ? ratio : 1;
    const template = proposeBookHedge(row, varSetup.exposureBasis, varSetup);
    const amountLocalM = remaining * bookRatio;
    const ticket: HedgeTicket = {
      ...template,
      amountLocalM,
      varUsdM: computeParametricVarUsdM(amountLocalM, ccy, varSetup),
    };
    if (Math.abs(ticket.amountLocalM) < 1e-9) return;
    setDraft(ticket);
  };

  const confirmBook = () => {
    if (!draft) return;
    // Each confirm appends a new transaction; incremental hedge % resets on the net book.
    const ticket: HedgeTicket = { ...draft, id: newHedgeTicketId() };
    setBooked([ticket, ...booked]);
    setRatios({ ...ratios, [ticket.ccy]: 0 });
    onBookHedge?.(ticket);
    setDraft(null);
  };

  /** Test Mode: cancel one booked transaction (others stay). */
  const requestCancellation = (ticket: HedgeTicket) => {
    setBooked(booked.filter(t => t.id !== ticket.id));
    setRatios({ ...ratios, [ticket.ccy]: 0 });
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
            Delta = 1 is fully unhedged (full VaR). Add hedge notional to reduce delta toward 0.
            VaR uses Analytics setup: {varSetup.confidencePct}% · {varSetup.horizon} ·{' '}
            {varSetup.exposureBasis}. Book hedge covers the selected exposure basis (stock → spot;
            avg buildup → forward @ {varSetup.horizon}). Residual VaR after follows booked trades.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => hedgeAll(0)}
            className="rounded-md border border-slate-600 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            Δ = 1 (unhedged)
          </button>
          <button
            type="button"
            onClick={() => hedgeAll(100)}
            className="rounded-md border border-emerald-600/50 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/20"
          >
            Δ = 0 (full hedge)
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="VaR at Δ = 1"
          value={fmtVarK(summary.totalVarBeforeUsdM)}
          hint="Unhedged · undiversified Σ"
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

      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-left text-xs">
          <thead>
            <tr className={`border-b ${border} ${head}`}>
              <th className="py-2 pr-3 font-medium">CCY</th>
              <th
                className="py-2 pr-3 font-medium"
                title="Cash FX + receivables + liability, net of booked hedges"
              >
                Stock now
              </th>
              <th
                className="py-2 pr-3 font-medium"
                title="S + 1.5×F average monthly buildup, net of booked hedges"
              >
                Stock + Avg exposure buildup
              </th>
              <th className="py-2 pr-3 font-medium">VaR @ Δ1</th>
              <th className="py-2 pr-3 font-medium">Hedge add</th>
              <th className="py-2 pr-3 font-medium">Delta</th>
              <th className="py-2 pr-3 font-medium">Residual</th>
              <th className="py-2 pr-3 font-medium">VaR after</th>
              <th className="py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map(r => {
              const riskRow = riskByCcy.get(r.ccy);
              const bookedAmt = bookedNotionalLocalM(booked, r.ccy);
              // Net of settled hedges (same as Live Ladder stock').
              const stockM =
                (riskRow?.bar.stockNetM ?? r.exposureLocalM) - bookedAmt;
              const avgM =
                (riskRow?.bar.avg3mM ?? r.exposureLocalM) - bookedAmt;
              const varStock = computeParametricVarUsdM(stockM, r.ccy, varSetup);
              const varAvg = computeParametricVarUsdM(avgM, r.ccy, varSetup);
              const higherAvg = varAvg > varStock + 1e-12;
              const flat = Math.abs(r.exposureLocalM) < 1e-9;
              const canBook = !flat;
              return (
                <tr
                  key={r.ccy}
                  className={`border-b ${border}/80 ${rowHover}${flat ? ' opacity-50' : ''}`}
                >
                  <td className="py-2.5 pr-3 font-semibold align-middle">{r.ccy}</td>
                  <td
                    className={`py-2.5 pr-3 font-mono align-middle ${
                      Math.abs(stockM) < 1e-9
                        ? 'text-slate-500'
                        : stockM >= 0
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                    }${!higherAvg ? ' font-semibold' : ''}`}
                    title={
                      bookedAmt !== 0
                        ? `Net of booked · ${fmtVarK(varStock)}`
                        : !higherAvg
                          ? `Higher VaR · ${fmtVarK(varStock)}`
                          : fmtVarK(varStock)
                    }
                  >
                    {fmtLocal(stockM, r.ccy)}
                  </td>
                  <td
                    className={`py-2.5 pr-3 font-mono align-middle ${
                      Math.abs(avgM) < 1e-9
                        ? 'text-slate-500'
                        : avgM >= 0
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                    }${higherAvg ? ' font-semibold' : ''}`}
                    title={
                      bookedAmt !== 0
                        ? `Net of booked · ${fmtVarK(varAvg)}`
                        : higherAvg
                          ? `Higher VaR · ${fmtVarK(varAvg)}`
                          : fmtVarK(varAvg)
                    }
                  >
                    {fmtLocal(avgM, r.ccy)}
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
            Booked hedges · {booked.length} transaction{booked.length === 1 ? '' : 's'}
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {booked.map(t => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-2 font-mono text-[11px]"
              >
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">
                  {t.instrument.toUpperCase()}
                </span>
                <span>{ticketLabel(t)}</span>
                <span className={muted}>
                  VaR {fmtVarK(t.varUsdM)}
                  {t.addressesHigherVar ? ' · higher VaR' : ''}
                </span>
                <button
                  type="button"
                  title="Cancel this hedge transaction"
                  onClick={() => requestCancellation(t)}
                  className="ml-auto rounded-md border border-rose-600/40 bg-rose-500/10 px-2 py-1 text-[10px] font-medium text-rose-300 hover:bg-rose-500/20"
                >
                  Request cancellation
                </button>
              </li>
            ))}
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
  onConfirm: () => void;
}) {
  const side = ticket.amountLocalM >= 0 ? 'Sell' : 'Buy';
  const basisLabel =
    ticket.basis === 'stock' ? 'Stock now' : 'Stock + Avg exposure buildup';
  const timeline =
    ticket.instrument === 'spot'
      ? 'Spot (T+2)'
      : `Forward · ${ticket.maturityLabel ?? ticket.maturity} (VaR horizon)`;

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
          {varSetup.exposureBasis === 'stock' ? 'stock now' : 'stock + avg exposure buildup'}) ·{' '}
          {varSetup.confidencePct}% · {varSetup.horizon}. Confirming zeros residual VaR for this
          CCY on that basis.
        </p>

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
          <Row term="Instrument" detail={
            <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-xs text-sky-300">
              {ticket.instrument.toUpperCase()}
            </span>
          } />
          <Row term="Timeline" detail={<span className="font-mono text-xs">{timeline}</span>} />
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
            detail={<span className="font-mono text-xs text-slate-300">{ticketLabel(ticket)}</span>}
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
            onClick={onConfirm}
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
          onClick={() => onChange(clampPct(pct - HEDGE_STEP_PCT))}
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
            aria-valuemax={100}
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
                onChange(clampPct(pct - HEDGE_STEP_PCT));
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
                onChange(100);
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
          disabled={disabled || pct >= 100}
          onClick={() => onChange(clampPct(pct + HEDGE_STEP_PCT))}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-30"
        >
          +
        </button>

        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          disabled={disabled}
          onChange={e => onChange(Number(e.target.value))}
          className="ml-1 w-20 accent-emerald-500 disabled:cursor-not-allowed"
          title={disabled ? 'No net exposure to hedge' : 'Drag for custom hedge %'}
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
