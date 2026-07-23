'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  CURRENCY_PARAMS,
  INITIAL_ROWS,
  INITIAL_USD_PARAMS,
  sumFcySwapNearUsd,
  fcyToUsdM,
  usdToFcyM,
  type RowState,
  type UsdParams,
  type SharedGlobals,
  type LayerId,
} from '@/lib/fx-buffer';
import type { FcyComputedRow, UsdComputedRow, PortfolioSummary } from '@/lib/dashboard-model';
import {
  resolveStrategyHedge,
  fwdHedgeCarryUsdYr,
  HEDGE_STRATEGIES,
  type HedgeStrategy,
} from '@/lib/fx-hedge';
import { FormulaCell } from '@/components/FormulaCell';
import { FormulaGridProvider } from '@/components/FormulaGrid';
import {
  resolveSimRow,
  SIM_FIELDS,
  SIM_FIELD_BY_KEY,
  type SimFieldKey,
} from '@/lib/sim-formulas';
import type { Scope } from '@/lib/formula';
import { setupLabel, type VarSetup } from '@/lib/test-mode/var-setup';

export type FxRiskMetricCell = {
  exposureLocalM: number;
  residualLocalM?: number;
  varUsdM: number;
  varBeforeUsdM?: number;
  spotHedgeLocalM?: number;
  forwardHedgeLocalM?: number;
};

// ─── Formatting helpers ───────────────────────────────────────────────────────

function f2(v: number)  { return isNaN(v) ? '—' : v.toFixed(2); }
function clr(v: number) { return v < 0 ? 'text-red-600' : 'text-gray-900'; }
function dclr(v: number){ return v > 0 ? 'text-red-600' : 'text-green-600'; }
/** Explicit "$M/yr" carry formatting so USD-denominated P&L cells never read
 *  as bare/ambiguous numbers (e.g. "16.58" vs "+$16.58"). */
function usdCarry(v: number, dust = 0.005): string {
  if (isNaN(v) || Math.abs(v) < dust) return '—';
  return v < 0 ? `-$${Math.abs(v).toFixed(2)}` : `+$${v.toFixed(2)}`;
}

function swapNearUsd(ccy: string, swapNear: number): number {
  return swapNear * (CURRENCY_PARAMS[ccy]?.spot ?? 1);
}

function fmtSwapUsd(v: number): string {
  if (Math.abs(v) < 0.005) return '—';
  return `${v >= 0 ? '+' : ''}${f2(v)}`;
}

/** Always show USD amount for Target NP Cash column (including zero). */
function fmtThresholdUsd(v: number): string {
  if (isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${f2(v)}`;
}

function fmtZeroSumUsd(v: number): string {
  if (Math.abs(v) < 0.005) return '✓ 0.00';
  return `${v >= 0 ? '+' : ''}${f2(v)}`;
}

function zeroSumCls(v: number): string {
  return Math.abs(v) < 0.01 ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700';
}

function CarryBadge({ dir }: { dir: 'earn' | 'pay' | 'neutral' }) {
  if (dir === 'earn') return <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">EARN</span>;
  if (dir === 'pay')  return <span className="rounded-full bg-red-100  px-1.5 py-0.5 text-xs font-medium text-red-700">PAY</span>;
  return <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">NEUT</span>;
}

// ─── Global param input ───────────────────────────────────────────────────────

function GParam({ label, value, min, max, step, unit, onChange }: {
  label: string;
  value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-[96px]">
      <label className="text-xs font-medium text-gray-700">{label}</label>
      <div className="flex items-center gap-1 mt-0.5">
        <input
          type="number" step={step} min={min} max={max} value={value}
          onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
          className="w-20 rounded border border-gray-300 px-2 py-1 text-xs text-right font-mono"
        />
        <span className="text-xs text-gray-400 whitespace-nowrap">{unit}</span>
      </div>
    </div>
  );
}

// ─── Style constants ──────────────────────────────────────────────────────────

const POLICY_VAR_LIMITS = [
  { usd: 5, label: '$5M', who: 'Treasury' },
  { usd: 10, label: '$10M', who: 'Director' },
  { usd: 20, label: '$20M', who: 'CFO' },
] as const;
const thBase = 'px-1.5 py-1 text-[11px] leading-tight font-semibold text-gray-600 whitespace-nowrap align-bottom text-right';
const tdBase = 'px-1.5 py-0.5 text-right text-[11px] whitespace-nowrap tabular-nums';
const inBase = 'text-right text-xs border-0 bg-transparent focus:bg-white focus:ring-1 focus:ring-blue-400 rounded px-0.5 outline-none';

// ─── Component ────────────────────────────────────────────────────────────────

export function UnifiedSimulator({
  shared, onSharedChange,
  setRows,
  usdCash, setUsdCash,
  usdNonNpCash, setUsdNonNpCash,
  usdParams, setUsdParams,
  activeLayers,
  onLayerToggle,
  policyVAR,
  onPolicyVARChange,
  portfolioSummary,
  fcyComputed,
  usdComputed,
  showRates = true,
  showFxPosition = true,
  showLiquidity = true,
  showBonds = false,
  showInvestments = false,
  showLiabilities = false,
  /** When false: hide rates toolbar layers, swap, hedge cols, carry (Task Mode simplified book). */
  showAdvancedBook = true,
  /** Risk Metrics / VaR column group — rendered immediately before P&L. */
  showRiskMetrics = false,
  /** Per-CCY VaR metrics for the Risk Metrics columns (keyed by currency). */
  riskMetricsByCcy = {},
  /** Analytics regime — labels VaR columns (confidence · horizon · basis). */
  varSetup,
  formulas,
  onFormulaChange,
}: {
  shared: SharedGlobals;
  onSharedChange: (key: keyof SharedGlobals, value: number) => void;
  rows: RowState[];
  setRows: React.Dispatch<React.SetStateAction<RowState[]>>;
  usdCash: number;
  setUsdCash: React.Dispatch<React.SetStateAction<number>>;
  usdNonNpCash: number;
  setUsdNonNpCash: React.Dispatch<React.SetStateAction<number>>;
  usdParams: UsdParams;
  setUsdParams: React.Dispatch<React.SetStateAction<UsdParams>>;
  activeLayers: Set<LayerId>;
  onLayerToggle: (id: LayerId) => void;
  policyVAR: number;
  onPolicyVARChange: (v: number) => void;
  portfolioSummary: PortfolioSummary | null;
  /** Precomputed FCY rows from unified background calculation (page.tsx). */
  fcyComputed: FcyComputedRow[];
  usdComputed: UsdComputedRow;
  /** Input-driven column-group visibility (from the FX risk-profile config). */
  showRates?: boolean;
  showFxPosition?: boolean;
  showLiquidity?: boolean;
  showBonds?: boolean;
  showInvestments?: boolean;
  showLiabilities?: boolean;
  showAdvancedBook?: boolean;
  showRiskMetrics?: boolean;
  riskMetricsByCcy?: Record<string, FxRiskMetricCell>;
  varSetup?: VarSetup;
  /** Per-cell formula overrides keyed `${ccy}::${fieldKey}`. */
  formulas?: Record<string, string>;
  onFormulaChange?: (cellKey: string, formula: string) => void;
}) {
  // IR / fixed-rate book section: shown when any of its inputs are selected.
  const irCols = (showBonds ? 2 : 0) + (showInvestments ? 2 : 0) + (showLiabilities ? 2 : 0);
  const showIrBook = showAdvancedBook && irCols > 0;
  const showCarry = showAdvancedBook;
  const showSwap = showAdvancedBook;
  const showFxHedge = showAdvancedBook;
  const showPnl = showAdvancedBook;
  // Rates / IR only apply in the full book (Task Mode simplified view omits them).
  const ratesOn = showAdvancedBook && showRates;
  /** Task Mode: Debt + Investments live in FX POSITION; every FX cell is editable. */
  const simplifiedFx = !showAdvancedBook;
  const fxPosColSpan = simplifiedFx ? 16 : 12;
  /** Exp · Spot · Fwd · Residual · VaR */
  const riskMetricCols = 5;
  const varRegimeLabel = varSetup ? setupLabel(varSetup) : '1M 95% VaR';
  const varTotalUsdM = Object.values(riskMetricsByCcy).reduce((s, m) => s + m.varUsdM, 0);
  const spotHedgeTotalLocal = Object.values(riskMetricsByCcy).reduce(
    (s, m) => s + Math.abs(m.spotHedgeLocalM ?? 0),
    0,
  );
  const fwdHedgeTotalLocal = Object.values(riskMetricsByCcy).reduce(
    (s, m) => s + Math.abs(m.forwardHedgeLocalM ?? 0),
    0,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const editRow = useCallback((id: string, field: keyof Omit<RowState, 'id' | 'ccy'>, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.${field}`]: raw }));
    const val = parseFloat(raw);
    if (!isNaN(val)) setRows(prev => prev.map(r => r.id === id ? { ...r, [field]: val } : r));
  }, [setRows]);

  const blurRow = useCallback((id: string, field: string) => {
    setDrafts(prev => { const next = { ...prev }; delete next[`${id}.${field}`]; return next; });
  }, []);

  // `fwd` is stored in USD (source of truth from TMS); this lets the FCY
  // column be edited directly too, converting back into the USD field so
  // both columns stay in sync — same two-way pattern as Cash FX / Cash FX $USD.
  const editFwdFcy = useCallback((id: string, ccy: string, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.fwdFcy`]: raw }));
    const val = parseFloat(raw);
    if (!isNaN(val)) setRows(prev => prev.map(r => r.id === id ? { ...r, fwd: fcyToUsdM(val, ccy) } : r));
  }, [setRows]);

  /** Edit a FCY-stored field via its $USD companion. */
  const editFcyViaUsd = useCallback((
    id: string,
    ccy: string,
    field: 'spot' | 'nonCash' | 'nonCashAsset' | 'ir_liab_notional' | 'ir_invest_notional',
    draftKey: string,
    raw: string,
  ) => {
    setDrafts(prev => ({ ...prev, [`${id}.${draftKey}`]: raw }));
    const val = parseFloat(raw);
    if (!isNaN(val)) {
      const fcy = usdToFcyM(val, ccy);
      setRows(prev => prev.map(r => (r.id === id ? { ...r, [field]: fcy } : r)));
    }
  }, [setRows]);

  /** Edit Net FX (FCY) by solving for Cash FX (spot). */
  const editNetFxFcy = useCallback((id: string, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.netFxFCY`]: raw }));
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const fwdFcy = usdToFcyM(r.fwd, r.ccy);
      return { ...r, spot: val - fwdFcy - r.nonCash - (r.nonCashAsset ?? 0) };
    }));
  }, [setRows]);

  const editNetFxUsd = useCallback((id: string, ccy: string, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.netFxUSD`]: raw }));
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const targetFcy = usdToFcyM(val, ccy);
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const fwdFcy = usdToFcyM(r.fwd, r.ccy);
      return { ...r, spot: targetFcy - fwdFcy - r.nonCash - (r.nonCashAsset ?? 0) };
    }));
  }, [setRows]);

  /** Edit Net FX Forecast by writing the residual into fcastFX. */
  const editNetFxForecast = useCallback((id: string, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.netFxForecast`]: raw }));
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const fwdFcy = usdToFcyM(r.fwd, r.ccy);
      const netFx = r.spot + fwdFcy + r.nonCash + (r.nonCashAsset ?? 0);
      return { ...r, fcastFX: val - netFx - r.collections - r.payout };
    }));
  }, [setRows]);

  const editNetFxForecastUsd = useCallback((id: string, ccy: string, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.netFxForecastUSD`]: raw }));
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const targetFcy = usdToFcyM(val, ccy);
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const fwdFcy = usdToFcyM(r.fwd, r.ccy);
      const netFx = r.spot + fwdFcy + r.nonCash + (r.nonCashAsset ?? 0);
      return { ...r, fcastFX: targetFcy - netFx - r.collections - r.payout };
    }));
  }, [setRows]);

  const editCcy = useCallback((id: string, raw: string) => {
    const ccy = raw.toUpperCase();
    setDrafts({});
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const p = CURRENCY_PARAMS[ccy];
      return p
        ? { ...r, ccy, σ_daily: p.σ_daily, r_FCY: p.carry, r_OD: p.r_OD, β_IR: p.β_IR }
        : { ...r, ccy };
    }));
  }, [setRows]);

  const editUsd = useCallback((field: keyof UsdParams, raw: string) => {
    setDrafts(prev => ({ ...prev, [`usd.${field}`]: raw }));
    const val = parseFloat(raw);
    if (!isNaN(val)) setUsdParams(prev => ({ ...prev, [field]: val }));
  }, [setUsdParams]);

  const blurUsd = useCallback((field: string) => {
    setDrafts(prev => { const next = { ...prev }; delete next[`usd.${field}`]; return next; });
  }, []);

  /** Book-wide hedging strategy: swap only / + forwards on forecast / + options. */
  const [strategy, setStrategy] = useState<HedgeStrategy>('SWAP_ONLY');
  /** Option δ override per row (default 0.5). */
  const [hedgeDeltas, setHedgeDeltas] = useState<Record<string, number>>({});

  const resetRows = useCallback(() => {
    setRows(INITIAL_ROWS);
    setUsdParams(INITIAL_USD_PARAMS);
    setUsdCash(303.9);
    setUsdNonNpCash(154.1);
    setStrategy('SWAP_ONLY');
    setHedgeDeltas({});
    setDrafts({});
  }, [setRows, setUsdParams, setUsdCash, setUsdNonNpCash]);

  const computed = fcyComputed;

  const totals = useMemo(() => computed.reduce(
    (a, r) => ({
      cashPosUSD:   a.cashPosUSD   + r.cashPosUSD,
      fxSpotUSD:    a.fxSpotUSD    + r.fxSpotUSD,
      fxFwdUSD:     a.fxFwdUSD     + r.fxFwdUSD,
      fxNonCashUSD: a.fxNonCashUSD + r.fxNonCashUSD,
      fxNonCashAssetUSD: a.fxNonCashAssetUSD + r.fxNonCashAssetUSD,
      netFxUSD:     a.netFxUSD     + r.netFxUSD,
    }),
    { cashPosUSD:0, fxSpotUSD:0, fxFwdUSD:0, fxNonCashUSD:0, fxNonCashAssetUSD:0, netFxUSD:0 }
  ), [computed]);

  const fxUsdTotals = useMemo(() => ({
    spot: totals.fxSpotUSD + usdComputed.fxSpotUSD,
    fwd: totals.fxFwdUSD + usdComputed.fxFwdUSD,
    nonCash: totals.fxNonCashUSD + usdComputed.fxNonCashUSD,
    nonCashAsset: totals.fxNonCashAssetUSD + usdComputed.fxNonCashAssetUSD,
    netFx: totals.netFxUSD + usdComputed.netFxUSD,
    cashPos: totals.cashPosUSD + usdComputed.cashPosUSD,
  }), [totals, usdComputed]);

  const usdComputedRow = usdComputed;

  const swapNearUsdTotal = useMemo(
    () => sumFcySwapNearUsd(computed.map(r => ({ ccy: r.ccy, swapNear: r.swapNear }))) + usdComputedRow.swapNear,
    [computed, usdComputedRow.swapNear],
  );

  const npCashUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + swapNearUsd(r.ccy, r.cash), 0) + usdComputedRow.cash,
    [computed, usdComputedRow.cash],
  );

  const thresholdUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + r.cashThresholdUSD, 0) + usdComputedRow.cashThresholdUSD,
    [computed, usdComputedRow.cashThresholdUSD],
  );

  const postSwapUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + r.postSwapUSD, 0) + usdComputedRow.postSwapUSD,
    [computed, usdComputedRow.postSwapUSD],
  );

  const cycleNetFlowUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + swapNearUsd(r.ccy, r.cash_after_payins), 0) + usdComputedRow.cash_after_payins,
    [computed, usdComputedRow.cash_after_payins],
  );

  const cycleEndUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + swapNearUsd(r.ccy, r.cycleEndCash), 0) + usdComputedRow.cycleEndCash,
    [computed, usdComputedRow.cycleEndCash],
  );

  const netDeltaUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + swapNearUsd(r.ccy, r.netDelta), 0) + usdComputedRow.netDelta,
    [computed, usdComputedRow.netDelta],
  );

  const floatNimUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + r.floatNim, 0) + usdComputedRow.floatNim,
    [computed, usdComputedRow.floatNim],
  );

  const swapCarryTotal = useMemo(
    () => computed.reduce((s, r) => s + r.swapCarryUsdYr, 0),
    [computed],
  );

  // ── FX Hedge — strategy applied per row on top of the swap book ─────────────
  //   Basis: Net FX Forecast = current net FX book (spot + fwd + non-cash) PLUS
  //   the expected cycle flows (payins + payouts) — the full cycle-end exposure.
  const computedWithHedge = useMemo(() =>
    computed.map(r => {
      // Option notional is always matched to the forward; δ is the option's own
      // delta (ATM ≈ 0.5) = fraction of the open exposure the option covers.
      const optDelta = hedgeDeltas[r.id] ?? 0.5;
      const hedge = resolveStrategyHedge(strategy, {
        ccy: r.ccy,
        currentFx: r.netFxFCY,
        forecastFx: r.netFxForecast,
        optDelta,
        horizonDays: 30,
        r_FCY: r.r_FCY,
        r_USD: shared.r_USD,
        σ_daily: r.σ_daily,
      });
      return { ...r, ...hedge };
    }),
    [computed, strategy, hedgeDeltas, shared.r_USD]
  );

  const hedgeTotals = useMemo(() => ({
    fwdUSD: computedWithHedge.reduce((s, r) => s + swapNearUsd(r.ccy, r.fwdNotional), 0),
    // Delta-effective option amounts (δ × written notional) — matches the per-row display.
    optUSD: computedWithHedge.reduce((s, r) => s + swapNearUsd(r.ccy, r.optNotional * r.optDelta), 0),
    residUSD: computedWithHedge.reduce((s, r) => s + swapNearUsd(r.ccy, r.residualFx), 0),
    hedgeCarryUsdYr: computedWithHedge.reduce((s, r) => s + r.hedgeCarryUsdYr, 0),
  }), [computedWithHedge]);

  // ── Per-cell formula resolution (Excel-like overrides) ────────────────────
  // Each editable field resolves against a named-reference scope built from the
  // row; defaults reproduce the current model. Hedge overrides also re-derive
  // that row's Residual FX and Hedge Carry so dependents stay consistent.
  const resolvedRows = useMemo(() => {
    const map: Record<string, {
      values: Record<SimFieldKey, number>;
      errors: Partial<Record<SimFieldKey, string>>;
      residualFx: number;
      hedgeCarryUsdYr: number;
    }> = {};
    for (const r of computedWithHedge) {
      const spotRate = CURRENCY_PARAMS[r.ccy]?.spot ?? 1;
      const base: Scope = {
        cash: r.cash, payout: r.payout, collections: r.collections, nonNpCash: r.nonNpCash,
        fcastFX: r.fcastFX, spot: r.spot, fwd: r.fwd, nonCash: r.nonCash, nonCashAsset: r.nonCashAsset ?? 0,
        rFCY: r.r_FCY, rOD: r.r_OD, rUSD: shared.r_USD, spotRate,
        netFxFCY: r.netFxFCY, netFxForecast: r.netFxForecast,
        fwdNotional: r.fwdNotional, optNotional: r.optNotional, optDelta: r.optDelta,
        swapNear: r.swapNear,
      };
      const overrides: Partial<Record<SimFieldKey, string>> = {};
      if (formulas) {
        for (const f of SIM_FIELDS) {
          const v = formulas[`${r.ccy}::${f.key}`];
          if (v) overrides[f.key] = v;
        }
      }
      const resolved = resolveSimRow(base, overrides);

      // Recompute residual + hedge carry only when a hedge leg is overridden,
      // so the untouched (model) case matches exactly.
      let residualFx = r.residualFx;
      let hedgeCarryUsdYr = r.hedgeCarryUsdYr;
      if (overrides.fwdHedgeUSD || overrides.optionHedgeUSD) {
        const fwdNotionalRes = spotRate ? resolved.values.fwdHedgeUSD / spotRate : 0;
        const optEffectiveRes = spotRate ? resolved.values.optionHedgeUSD / spotRate : 0;
        residualFx = r.netFxForecast + fwdNotionalRes + optEffectiveRes;
        hedgeCarryUsdYr = fwdHedgeCarryUsdYr(fwdNotionalRes, r.ccy, r.r_FCY, shared.r_USD)
          + fwdHedgeCarryUsdYr(optEffectiveRes, r.ccy, r.r_FCY, shared.r_USD);
      }
      map[r.ccy] = { values: resolved.values, errors: resolved.errors, residualFx, hedgeCarryUsdYr };
    }
    return map;
  }, [computedWithHedge, formulas, shared.r_USD]);

  // Total annual USD carry = natural cash float + swap interest overlay + FX hedge carry.
  const totalCarryUsd = floatNimUsdTotal + swapCarryTotal + hedgeTotals.hedgeCarryUsdYr;

  return (
    <div className="space-y-4">

      {/* ── Global parameters ── */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <GParam
            label="USD deposit rate r_USD"
            value={shared.r_USD} min={0} max={10} step={0.05} unit="% p.a."
            onChange={v => onSharedChange('r_USD', v)}
          />
          <GParam
            label="Payout forecast uncertainty"
            value={shared.σ_P * 100} min={0} max={40} step={1} unit="%"
            onChange={v => onSharedChange('σ_P', v / 100)}
          />
          <div className="flex items-end gap-2 ml-auto">
            <button
              onClick={resetRows}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
            >
              Reset table
            </button>
          </div>
        </div>
        {showAdvancedBook && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Formula layer toggles — same state as Layer Setup tab */}
          <span className="text-xs font-medium text-gray-500">Layers:</span>
          {[
            { id: 'floorH' as LayerId, label: 'Min floor', hint: 'Hard minimum cash per currency' },
            { id: 'sigmaP' as LayerId, label: 'Payout σ buffer', hint: 'Safety margin on uncovered payout deficit (prefunded payout → σ = 0)' },
            { id: 'carryOptim' as LayerId, label: 'Carry target', hint: 'Rate-driven buffer shift (PAY sell / EARN buy)' },
            { id: 'portfolioDiv' as LayerId, label: 'Portfolio VAR', hint: 'Cross-currency rebalance with VAR / USD budget limits' },
          ].map(l => {
            const on = activeLayers.has(l.id);
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => onLayerToggle(l.id)}
                title={l.hint}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                  on
                    ? 'bg-blue-50 text-blue-800 border-blue-300 hover:bg-blue-100'
                    : 'bg-gray-50 text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-600'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${on ? 'bg-blue-600' : 'bg-gray-300'}`} />
                {l.label}
              </button>
            );
          })}

          <span className="ml-4 text-xs font-medium text-gray-500">Hedging strategy:</span>
          {HEDGE_STRATEGIES.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStrategy(s.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                strategy === s.id
                  ? 'bg-rose-50 text-rose-800 border-rose-300 hover:bg-rose-100'
                  : 'bg-gray-50 text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-600'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${strategy === s.id ? 'bg-rose-600' : 'bg-gray-300'}`} />
              {s.label}
            </button>
          ))}
        </div>

        )}

        {showAdvancedBook && activeLayers.has('portfolioDiv') && portfolioSummary && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
            <span
              className="text-xs font-semibold text-violet-800"
              title="Notional sensitivity limit — caps the portfolio's position sensitivity (net notional × FX volatility σ, with cross-currency diversification). This is NOT a P&L limit: a true P&L limit would be a stochastic VAR on the mark-to-market FX exposure value, revalued daily."
            >
              Portfolio notional sensitivity limit
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-violet-600">Sensitivity limit:</span>
              {POLICY_VAR_LIMITS.map(pl => (
                <button
                  key={pl.usd}
                  type="button"
                  onClick={() => onPolicyVARChange(pl.usd)}
                  className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                    policyVAR === pl.usd
                      ? 'bg-violet-700 text-white border-violet-700'
                      : 'bg-white text-violet-600 border-violet-300 hover:bg-violet-100'
                  }`}
                  title={`${pl.label} (${pl.who} approval)`}
                >
                  {pl.label}
                </button>
              ))}
              <input
                type="range"
                min={0.5}
                max={25}
                step={0.5}
                value={policyVAR}
                onChange={e => onPolicyVARChange(Number(e.target.value))}
                className="w-36 accent-violet-700"
                title="Drag to set any intermediate notional sensitivity limit ($0.5M–$25M, $0.5M steps)"
              />
              <input
                type="number"
                min={0.5}
                max={25}
                step={0.5}
                value={policyVAR}
                onChange={e => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) onPolicyVARChange(Math.min(25, Math.max(0.5, v)));
                }}
                className="w-16 rounded border border-violet-300 bg-white px-1.5 py-0.5 text-right text-xs font-mono text-violet-800 focus:ring-1 focus:ring-violet-400 outline-none"
                title="Type an exact notional sensitivity limit in $M"
              />
              <span className="text-xs text-violet-600">$M</span>
            </div>
            <span
              className={`text-xs font-mono ${
                portfolioSummary.portfolio_VAR_USD > portfolioSummary.policyVAR
                  ? 'text-red-700 font-semibold'
                  : 'text-green-700'
              }`}
              title="Notional sensitivity of the carry overlay (deviation from hold-the-book), measured as net notional × FX volatility σ with diversification — existing NP holdings are not charged against the sensitivity budget. Not a daily-revalued P&L VAR."
            >
              Overlay sensitivity ${f2(portfolioSummary.portfolio_VAR_USD)}M / ${f2(portfolioSummary.policyVAR)}M limit
            </span>
            <span
              className={`text-xs font-mono font-semibold ${
                portfolioSummary.overlay_carry_USD >= 0 ? 'text-emerald-700' : 'text-red-700'
              }`}
              title="Incremental annual USD carry from the discretionary overlay vs hold-the-book: Σ (target − base) × spot × (r_FCY − r_USD)/100. Already embedded in Cash Carry (post-swap economic P&L) — shown here as the VAR-budget attribution, not an add-on."
            >
              Overlay carry {portfolioSummary.overlay_carry_USD >= 0 ? '+' : ''}${f2(portfolioSummary.overlay_carry_USD)}M/yr
            </span>
            {portfolioSummary.var_binding && !portfolioSummary.budget_binding && (
              <span className="text-xs font-medium text-green-700">✓ Carry maximized</span>
            )}
            {portfolioSummary.budget_binding && (
              <span className="text-xs font-medium text-orange-700">⚠ USD budget binding</span>
            )}
            {portfolioSummary.stress_trim && (
              <span className="text-xs font-medium text-orange-700">⚠ USD stress trim</span>
            )}
            {portfolioSummary.var_trim && (
              <span className="text-xs font-medium text-amber-700">⚠ Overlay trimmed</span>
            )}
            {!portfolioSummary.var_binding && !portfolioSummary.budget_binding && !portfolioSummary.stress_trim
              && portfolioSummary.portfolio_VAR_USD <= portfolioSummary.policyVAR && (
              <span className="text-xs text-green-700">✓ Within limit</span>
            )}
          </div>
        )}
      </div>

      {/* ── Main table ── */}
      <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-10rem)] rounded-lg border border-gray-200">
        <FormulaGridProvider
          rowOrder={computedWithHedge.map(r => r.ccy)}
          onFill={(columnKey, ccy, formulaText) => onFormulaChange?.(`${ccy}::${columnKey}`, formulaText)}
        >
        <table className="w-max min-w-full text-xs border-collapse">
          <thead className="sticky top-0 z-30">

            {/* ── Group header row ── */}
            <tr className="border-b border-gray-200">
              <th className="sticky left-0 top-0 z-50 bg-gray-100 px-2 py-1 text-left text-xs font-bold text-gray-700 align-middle shadow-[2px_0_4px_-2px_rgba(0,0,0,0.12)]" rowSpan={2}>
                CCY
              </th>

              {ratesOn && (
                <th className="border-l border-gray-300 bg-gray-50 px-2 py-1 text-center text-xs font-semibold text-gray-600 tracking-wide" colSpan={3}>
                  RATES
                </th>
              )}

              {showFxPosition && (
                <th className="border-l border-gray-300 bg-white px-2 py-1 text-center text-xs font-semibold text-gray-600 tracking-wide" colSpan={fxPosColSpan}>
                  FX POSITION
                </th>
              )}

              {showLiquidity && (
                <th className="border-l border-gray-300 bg-sky-50 px-2 py-1 text-center text-xs font-semibold text-sky-700 tracking-wide" colSpan={9}>
                  LIQUIDITY BOOK
                </th>
              )}

              {showIrBook && (
                <th className="border-l border-gray-300 bg-rose-50 px-2 py-1 text-center text-xs font-semibold text-rose-700 tracking-wide" colSpan={irCols}>
                  IR / FIXED-RATE BOOK
                </th>
              )}

              {showCarry && (
                <th className="border-l border-gray-300 bg-amber-50 px-2 py-1 text-center text-xs font-semibold text-amber-700 tracking-wide" colSpan={3}>
                  CARRY / BUFFER
                </th>
              )}

              {showSwap && (
                <th className="border-l border-gray-300 bg-emerald-50 px-2 py-1 text-center text-xs font-semibold text-emerald-700 tracking-wide" colSpan={6}>
                  SWAP
                </th>
              )}

              {showFxHedge && (
                <th className="border-l-2 border-rose-400 bg-rose-50 px-2 py-1 text-center text-xs font-semibold text-rose-700 tracking-wide" colSpan={5}>
                  FX HEDGE
                  <span className="ml-1 font-normal text-rose-400">all $USD M</span>
                  {strategy === 'SWAP_ONLY' && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800 normal-case">
                      Swap only — no fwd/option placed; select Swap + Fwd (± Option) above to hedge the forecast
                    </span>
                  )}
                </th>
              )}

              {showRiskMetrics && (
                <th
                  className="border-l border-violet-400 bg-violet-50 px-2 py-1 text-center text-xs font-semibold text-violet-800 tracking-wide"
                  colSpan={riskMetricCols}
                >
                  RISK METRICS
                  <span className="ml-1 font-normal text-violet-400">{varRegimeLabel}</span>
                </th>
              )}

              {showPnl && (
                <th className="border-l border-gray-300 bg-purple-50 px-2 py-1 text-center text-xs font-semibold text-purple-700 tracking-wide" colSpan={5}>
                  P&L
                </th>
              )}
            </tr>

            {/* ── Column name row ── */}
            <tr className="border-b-2 border-gray-300 bg-white">

              {/* RATES ×3 */}
              {ratesOn && (<>
              <th className={`${thBase} bg-gray-50 border-l border-gray-300 min-w-[64px]`}>Credit Rate</th>
              <th className={`${thBase} bg-gray-50 min-w-[64px]`}>Debit Rate</th>
              <th className={`${thBase} bg-gray-50 min-w-[68px]`}>Rate Spread</th>
              </>)}

              {/* FX POSITION */}
              {showFxPosition && (<>
              <th className={`${thBase} bg-white border-l border-gray-300 min-w-[68px]`}>Cash FX</th>
              <th className={`${thBase} bg-white min-w-[68px]`}>Cash FX $USD</th>
              <th className={`${thBase} bg-white min-w-[68px]`}>Fwd (FCY)</th>
              <th className={`${thBase} bg-white min-w-[68px]`}>Fwd $USD</th>
              <th className={`${thBase} bg-white min-w-[76px]`} title="Receivables — accruals/receivables/NDF assets (M FCY, positive increases exposure)">Receivables</th>
              <th className={`${thBase} bg-white min-w-[80px]`}>Receivables $USD</th>
              <th className={`${thBase} bg-white min-w-[72px]`} title="Non-cash LIABILITY FX exposure — payables/accruals (M FCY, enter negative to reduce exposure)">Liability (FCY)</th>
              <th className={`${thBase} bg-white min-w-[72px]`}>liability $USD</th>
              {simplifiedFx && (<>
              <th className={`${thBase} bg-white min-w-[68px]`} title="Debt / borrowings notional (M FCY)">Debt (FCY)</th>
              <th className={`${thBase} bg-white min-w-[68px]`}>Debt $USD</th>
              <th className={`${thBase} bg-white min-w-[76px]`} title="Investment notional (M FCY)">Investments (FCY)</th>
              <th className={`${thBase} bg-white min-w-[76px]`}>Investments $USD</th>
              </>)}
              <th className={`${thBase} bg-white min-w-[68px]`}>Net FX (FCY)</th>
              <th className={`${thBase} bg-white min-w-[68px]`}>Net FX $USD</th>
              <th className={`${thBase} bg-white min-w-[76px]`} title="Current net FX book + expected payins/payouts + invoice forecast (M FCY) — hedging basis">Net FX Forecast</th>
              <th className={`${thBase} bg-white min-w-[80px]`}>Net FX Forecast $USD</th>
              </>)}

              {/* LIQUIDITY ×9 */}
              {showLiquidity && (<>
              <th className={`${thBase} bg-sky-50 border-l border-sky-200 min-w-[64px]`}>NP Cash</th>
              <th className={`${thBase} bg-sky-100 min-w-[68px]`}>NP Cash $USD</th>
              <th className={`${thBase} bg-sky-50 min-w-[68px]`}>Gross Payouts</th>
              <th className={`${thBase} bg-sky-50 min-w-[64px]`}>Gross Payins</th>
              <th className={`${thBase} bg-sky-50 min-w-[72px]`}>Non-NP Cash</th>
              <th className={`${thBase} bg-sky-100 min-w-[76px]`}>Trough Cash</th>
              <th className={`${thBase} bg-sky-100 min-w-[80px]`}>Cycle Net Flow</th>
              <th className={`${thBase} bg-sky-50 min-w-[72px]`}>Total Cash</th>
              <th className={`${thBase} bg-sky-100 min-w-[68px]`}>Total Cash $USD</th>
              </>)}

              {/* IR / FIXED-RATE BOOK — gated per input */}
              {showBonds && (<>
              <th className={`${thBase} bg-rose-50 border-l border-rose-200 min-w-[68px]`}>Bonds (FCY)</th>
              <th className={`${thBase} bg-rose-50 min-w-[56px]`}>Bond %</th>
              </>)}
              {showInvestments && (<>
              <th className={`${thBase} bg-rose-50 border-l border-rose-200 min-w-[72px]`}>Investm. (FCY)</th>
              <th className={`${thBase} bg-rose-50 min-w-[56px]`}>Invest %</th>
              </>)}
              {showLiabilities && (<>
              <th className={`${thBase} bg-rose-50 border-l border-rose-200 min-w-[72px]`}>Liabs (FCY)</th>
              <th className={`${thBase} bg-rose-50 min-w-[56px]`}>Liab %</th>
              </>)}

              {showCarry && (<>
              {/* CARRY / BUFFER ×3 */}
              <th className={`${thBase} bg-amber-50 border-l border-gray-300 min-w-[52px] text-center`}>Carry</th>
              <th className={`${thBase} bg-amber-50 min-w-[72px]`}>Target NP Cash</th>
              <th className={`${thBase} bg-amber-100 min-w-[72px]`}>Target NP Cash $USD</th>
              </>)}

              {showSwap && (<>
              {/* SWAP ×6 */}
              <th className={`${thBase} bg-emerald-50 border-l border-gray-300 min-w-[64px]`}>Swap Near</th>
              <th className={`${thBase} bg-emerald-100 min-w-[64px]`}>Swap $USD</th>
              <th className={`${thBase} bg-emerald-50 min-w-[68px]`}>NP+Swap</th>
              <th className={`${thBase} bg-emerald-100 min-w-[68px]`}>NP+Swap $USD</th>
              <th className={`${thBase} bg-emerald-50 min-w-[72px]`}>Cycle End</th>
              <th className={`${thBase} bg-emerald-100 min-w-[72px]`}>Cycle End $USD</th>
              </>)}

              {showFxHedge && (<>
              {/* FX HEDGE ×5 — all figures in $USD M */}
              <th className={`${thBase} bg-rose-50 border-l-2 border-rose-400 min-w-[72px]`} title="Outright forward notional in $USD M (− = sell FCY fwd)">Fwd Hedge $USD</th>
              <th className={`${thBase} bg-rose-50 min-w-[84px]`} title="SHORT option — delta-effective option hedge = δ × written notional; the written notional is matched 1:1 to the forward at all deltas, so the displayed amount = δ × Fwd Hedge $USD (δ 1 = full forward, δ 0.5 = half, δ → 0 = nothing). PAY carry: sell CALL (exercise: sell USD, buy LCY); EARN carry: sell PUT (exercise: buy USD, sell LCY). Amount in $USD M">Option Hedge $USD</th>
              <th className={`${thBase} bg-rose-50 min-w-[44px] text-center`} title="Option delta — ATM ≈ 0.5. The written notional stays matched 1:1 to the forward at all deltas; δ scales only the delta-effective hedge shown in the Option column (= δ × notional), linear from the full forward at δ = 1 down to zero at δ = 0">Δ</th>
              <th className={`${thBase} bg-rose-100 min-w-[76px]`} title="Fwd points + option δ-leg delivery points, $M/yr USD. Gross premium harvested is shown in the cell tooltip for reference only — at fair value it offsets the expected exercise cost, so it is EXCLUDED from carry">Hedge Carry $USD</th>
              <th className={`${thBase} bg-rose-100 min-w-[76px]`} title="Net FX Forecast + total hedge (Fwd + δ × Option) — what stays open, in $USD M">Residual FX $USD</th>
              </>)}

              {showRiskMetrics && (<>
              <th
                className={`${thBase} bg-violet-50 border-l border-violet-300 min-w-[72px]`}
                title="Analytics exposure basis (stock or avg buildup), M FCY — unhedged"
              >
                Exp
              </th>
              <th
                className={`${thBase} bg-emerald-50 min-w-[72px]`}
                title="Booked / proposed spot hedges from Hedging Decision (M FCY, signed with exposure)"
              >
                Spot hedge
              </th>
              <th
                className={`${thBase} bg-emerald-50 min-w-[72px]`}
                title="Booked / proposed forward hedges from Hedging Decision (M FCY, signed with exposure)"
              >
                Fwd hedge
              </th>
              <th
                className={`${thBase} bg-violet-50 min-w-[72px]`}
                title="Exposure remaining after spot + forward hedges (M FCY)"
              >
                Residual
              </th>
              <th
                className={`${thBase} bg-violet-100 min-w-[80px]`}
                title={`Parametric VaR on residual under Analytics regime: ${varRegimeLabel}`}
              >
                VaR $USD
              </th>
              </>)}

              {showPnl && (<>
              {/* P&L ×5 — all USD-denominated, $M/yr for carry columns */}
              <th className={`${thBase} bg-purple-50 border-l border-gray-300 min-w-[76px]`}>Net Delta $USD</th>
              <th className={`${thBase} bg-purple-50 min-w-[76px]`}>Cash Carry $USD</th>
              <th className={`${thBase} bg-purple-50 min-w-[76px]`}>Swap Carry $USD</th>
              <th className={`${thBase} bg-purple-50 min-w-[76px]`}>Hedge Carry $USD</th>
              <th className={`${thBase} bg-purple-100 min-w-[80px]`}>Total Carry $USD</th>
              </>)}

            </tr>
          </thead>

          <tbody>
            {computedWithHedge.map(r => {
              const R = resolvedRows[r.ccy];
              const fv = (k: SimFieldKey) => R?.values[k] ?? NaN;
              const fErr = (k: SimFieldKey) => R?.errors[k];
              const fFormula = (k: SimFieldKey) => formulas?.[`${r.ccy}::${k}`];
              const fCommit = (k: SimFieldKey) => (text: string) => {
                const norm = text.trim().replace(/^=/, '').trim();
                const def = SIM_FIELD_BY_KEY[k].defaultFormula;
                onFormulaChange?.(`${r.ccy}::${k}`, norm === '' || norm === def ? '' : text.trim());
              };
              const hedgeCarry = R?.hedgeCarryUsdYr ?? r.hedgeCarryUsdYr;
              const residual = R?.residualFx ?? r.residualFx;
              return (
              <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50/50">

                {/* CCY */}
                <td className="sticky left-0 z-20 bg-white hover:bg-gray-50 px-1.5 py-0.5 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]">
                  <input
                    type="text" value={r.ccy} maxLength={6}
                    onChange={e => editCcy(r.id, e.target.value)}
                    className="w-[52px] text-left text-xs font-bold text-gray-900 border-0 bg-transparent focus:bg-white focus:ring-1 focus:ring-blue-400 rounded px-0.5 outline-none uppercase"
                  />
                </td>

                {/* RATES */}
                {ratesOn && (<>
                <td className={`${tdBase} bg-gray-50 border-l border-gray-300`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.r_FCY`] ?? r.r_FCY}
                    onChange={e => editRow(r.id, 'r_FCY', e.target.value)}
                    onBlur={() => blurRow(r.id, 'r_FCY')}
                    className={`${inBase} w-[52px]`} />
                </td>
                <td className={`${tdBase} bg-gray-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.r_OD`] ?? r.r_OD}
                    onChange={e => editRow(r.id, 'r_OD', e.target.value)}
                    onBlur={() => blurRow(r.id, 'r_OD')}
                    className={`${inBase} w-[52px]`} />
                </td>
                <td className={`${tdBase} bg-gray-50 font-medium ${dclr(r.delta_r)}`}>
                  {r.delta_r > 0 ? '+' : ''}{f2(r.delta_r)}%
                </td>
                </>)}

                {/* FX POSITION — spot/fwd/non-cash in FCY + USD */}
                {showFxPosition && (<>
                <td className={`${tdBase} bg-white border-l border-gray-300`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.spot`] ?? r.spot}
                    onChange={e => editRow(r.id, 'spot', e.target.value)}
                    onBlur={() => blurRow(r.id, 'spot')}
                    className={`${inBase} w-[62px] ${r.spot < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.spotUsd`] ?? r.fxSpotUSD}
                      onChange={e => editFcyViaUsd(r.id, r.ccy, 'spot', 'spotUsd', e.target.value)}
                      onBlur={() => blurRow(r.id, 'spotUsd')}
                      className={`${inBase} w-[62px] font-medium ${r.fxSpotUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.fxSpotUSD)}`}>{f2(r.fxSpotUSD)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.fwdFcy`] ?? r.fxFwdFCY}
                    onChange={e => editFwdFcy(r.id, r.ccy, e.target.value)}
                    onBlur={() => blurRow(r.id, 'fwdFcy')}
                    className={`${inBase} w-[62px] font-medium ${r.fxFwdFCY < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.fwd`] ?? r.fwd}
                    onChange={e => editRow(r.id, 'fwd', e.target.value)}
                    onBlur={() => blurRow(r.id, 'fwd')}
                    className={`${inBase} w-[62px] ${r.fwd < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.nonCashAsset`] ?? (r.nonCashAsset ?? 0)}
                    onChange={e => editRow(r.id, 'nonCashAsset', e.target.value)}
                    onBlur={() => blurRow(r.id, 'nonCashAsset')}
                    className={`${inBase} w-[58px] ${(r.nonCashAsset ?? 0) < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.nonCashAssetUsd`] ?? r.fxNonCashAssetUSD}
                      onChange={e => editFcyViaUsd(r.id, r.ccy, 'nonCashAsset', 'nonCashAssetUsd', e.target.value)}
                      onBlur={() => blurRow(r.id, 'nonCashAssetUsd')}
                      className={`${inBase} w-[62px] font-medium ${r.fxNonCashAssetUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.fxNonCashAssetUSD)}`}>{f2(r.fxNonCashAssetUSD)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.nonCash`] ?? r.nonCash}
                    onChange={e => editRow(r.id, 'nonCash', e.target.value)}
                    onBlur={() => blurRow(r.id, 'nonCash')}
                    className={`${inBase} w-[58px] ${r.nonCash < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.nonCashUsd`] ?? r.fxNonCashUSD}
                      onChange={e => editFcyViaUsd(r.id, r.ccy, 'nonCash', 'nonCashUsd', e.target.value)}
                      onBlur={() => blurRow(r.id, 'nonCashUsd')}
                      className={`${inBase} w-[62px] font-medium ${r.fxNonCashUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.fxNonCashUSD)}`}>{f2(r.fxNonCashUSD)}</span>
                  )}
                </td>
                {simplifiedFx && (<>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_liab_notional`] ?? r.ir_liab_notional}
                    onChange={e => editRow(r.id, 'ir_liab_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_liab_notional')}
                    className={`${inBase} w-[58px] ${r.ir_liab_notional < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal"
                    value={drafts[`${r.id}.debtUsd`] ?? fcyToUsdM(r.ir_liab_notional, r.ccy)}
                    onChange={e => editFcyViaUsd(r.id, r.ccy, 'ir_liab_notional', 'debtUsd', e.target.value)}
                    onBlur={() => blurRow(r.id, 'debtUsd')}
                    className={`${inBase} w-[62px] font-medium ${fcyToUsdM(r.ir_liab_notional, r.ccy) < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_invest_notional`] ?? (r.ir_invest_notional ?? 0)}
                    onChange={e => editRow(r.id, 'ir_invest_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_invest_notional')}
                    className={`${inBase} w-[58px] ${(r.ir_invest_notional ?? 0) < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal"
                    value={drafts[`${r.id}.investUsd`] ?? fcyToUsdM(r.ir_invest_notional ?? 0, r.ccy)}
                    onChange={e => editFcyViaUsd(r.id, r.ccy, 'ir_invest_notional', 'investUsd', e.target.value)}
                    onBlur={() => blurRow(r.id, 'investUsd')}
                    className={`${inBase} w-[62px] font-medium ${fcyToUsdM(r.ir_invest_notional ?? 0, r.ccy) < 0 ? 'text-red-600' : ''}`} />
                </td>
                </>)}
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.netFxFCY`] ?? r.netFxFCY}
                      onChange={e => editNetFxFcy(r.id, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxFCY')}
                      className={`${inBase} w-[62px] font-medium ${r.netFxFCY < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.netFxFCY)}`}>{f2(r.netFxFCY)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.netFxUSD`] ?? r.netFxUSD}
                      onChange={e => editNetFxUsd(r.id, r.ccy, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxUSD')}
                      className={`${inBase} w-[62px] font-medium ${r.netFxUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.netFxUSD)}`}>{f2(r.netFxUSD)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}
                  title={`Net FX (${f2(r.netFxFCY)}) + Payins (${f2(r.collections)}) + Payouts (${f2(r.payout)}) + Fcast (${f2(r.fcastFX)}) = ${f2(r.netFxForecast)} M FCY`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.netFxForecast`] ?? r.netFxForecast}
                      onChange={e => editNetFxForecast(r.id, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxForecast')}
                      className={`${inBase} w-[62px] font-medium ${r.netFxForecast < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${Math.abs(r.netFxForecast) < 0.005 ? 'text-gray-300' : clr(r.netFxForecast)}`}>
                      {Math.abs(r.netFxForecast) < 0.005 ? '—' : f2(r.netFxForecast)}
                    </span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal"
                      value={drafts[`${r.id}.netFxForecastUSD`] ?? fcyToUsdM(r.netFxForecast, r.ccy)}
                      onChange={e => editNetFxForecastUsd(r.id, r.ccy, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxForecastUSD')}
                      className={`${inBase} w-[62px] font-medium ${fcyToUsdM(r.netFxForecast, r.ccy) < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(fcyToUsdM(r.netFxForecast, r.ccy))}`}>
                      {f2(fcyToUsdM(r.netFxForecast, r.ccy))}
                    </span>
                  )}
                </td>
                </>)}

                {/* LIQUIDITY */}
                {showLiquidity && (<>
                <td className={`${tdBase} bg-sky-50 border-l border-sky-200`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.cash`] ?? r.cash}
                    onChange={e => editRow(r.id, 'cash', e.target.value)}
                    onBlur={() => blurRow(r.id, 'cash')}
                    className={`${inBase} w-[58px] ${r.cash < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-sky-100 font-medium ${clr(swapNearUsd(r.ccy, r.cash))}`}
                  title={`${f2(r.cash)} M FCY × spot ${(CURRENCY_PARAMS[r.ccy]?.spot ?? 1).toFixed(4)}`}>
                  {f2(swapNearUsd(r.ccy, r.cash))}
                </td>
                <td className={`${tdBase} bg-sky-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.payout`] ?? r.payout}
                    onChange={e => editRow(r.id, 'payout', e.target.value)}
                    onBlur={() => blurRow(r.id, 'payout')}
                    className={`${inBase} w-[62px] ${r.payout < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-sky-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.collections`] ?? r.collections}
                    onChange={e => editRow(r.id, 'collections', e.target.value)}
                    onBlur={() => blurRow(r.id, 'collections')}
                    className={`${inBase} w-[58px]`} />
                </td>
                <td className={`${tdBase} bg-sky-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.nonNpCash`] ?? r.nonNpCash}
                    onChange={e => editRow(r.id, 'nonNpCash', e.target.value)}
                    onBlur={() => blurRow(r.id, 'nonNpCash')}
                    className={`${inBase} w-[58px] ${r.nonNpCash < 0 ? 'text-red-600' : ''}`} />
                </td>
                <FormulaCell
                  tdClass={`${tdBase} bg-sky-100 font-semibold ${
                    fv('troughCash') >= fv('targetNpCash') ? 'text-green-700'
                    : fv('troughCash') >= 0 ? 'text-amber-700' : 'text-red-600'}`}
                  display={f2(fv('troughCash'))}
                  formula={fFormula('troughCash')} defaultFormula={SIM_FIELD_BY_KEY.troughCash.defaultFormula}
                  onCommit={fCommit('troughCash')} error={fErr('troughCash')} title="Trough Cash"
                  columnKey="troughCash" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-sky-100 font-medium ${fv('cycleNetFlow') >= 0 ? 'text-green-700' : 'text-red-600'}`}
                  display={f2(fv('cycleNetFlow'))}
                  formula={fFormula('cycleNetFlow')} defaultFormula={SIM_FIELD_BY_KEY.cycleNetFlow.defaultFormula}
                  onCommit={fCommit('cycleNetFlow')} error={fErr('cycleNetFlow')} title="Cycle Net Flow"
                  columnKey="cycleNetFlow" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-sky-50 font-medium ${clr(fv('totalCash'))}`}
                  display={f2(fv('totalCash'))}
                  formula={fFormula('totalCash')} defaultFormula={SIM_FIELD_BY_KEY.totalCash.defaultFormula}
                  onCommit={fCommit('totalCash')} error={fErr('totalCash')} title="Total Cash"
                  columnKey="totalCash" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-sky-100 font-medium ${clr(fv('totalCashUSD'))}`}
                  display={f2(fv('totalCashUSD'))}
                  formula={fFormula('totalCashUSD')} defaultFormula={SIM_FIELD_BY_KEY.totalCashUSD.defaultFormula}
                  onCommit={fCommit('totalCashUSD')} error={fErr('totalCashUSD')} title="Total Cash $USD"
                  columnKey="totalCashUSD" rowKey={r.ccy} />
                </>)}

                {/* IR / FIXED-RATE BOOK */}
                {showBonds && (<>
                <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_asset_notional`] ?? r.ir_asset_notional}
                    onChange={e => editRow(r.id, 'ir_asset_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_asset_notional')}
                    className={`${inBase} w-[58px]`} />
                </td>
                <td className={`${tdBase} bg-rose-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_asset_rate`] ?? r.ir_asset_rate}
                    onChange={e => editRow(r.id, 'ir_asset_rate', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_asset_rate')}
                    className={`${inBase} w-[46px]`} />
                </td>
                </>)}
                {showInvestments && (<>
                <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_invest_notional`] ?? (r.ir_invest_notional ?? 0)}
                    onChange={e => editRow(r.id, 'ir_invest_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_invest_notional')}
                    className={`${inBase} w-[58px]`} />
                </td>
                <td className={`${tdBase} bg-rose-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_invest_rate`] ?? (r.ir_invest_rate ?? 0)}
                    onChange={e => editRow(r.id, 'ir_invest_rate', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_invest_rate')}
                    className={`${inBase} w-[46px]`} />
                </td>
                </>)}
                {showLiabilities && (<>
                <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_liab_notional`] ?? r.ir_liab_notional}
                    onChange={e => editRow(r.id, 'ir_liab_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_liab_notional')}
                    className={`${inBase} w-[58px]`} />
                </td>
                <td className={`${tdBase} bg-rose-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_liab_rate`] ?? r.ir_liab_rate}
                    onChange={e => editRow(r.id, 'ir_liab_rate', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_liab_rate')}
                    className={`${inBase} w-[46px]`} />
                </td>
                </>)}

{showAdvancedBook && (<>
                {/* CARRY / BUFFER */}
                <td className={`${tdBase} bg-amber-50 border-l border-gray-300 text-center`}>
                  <CarryBadge dir={r.carryDir} />
                </td>
                <FormulaCell
                  tdClass={`${tdBase} bg-amber-50 font-semibold text-amber-900`}
                  display={<>{f2(fv('targetNpCash'))}{r.funding_binding && <span className="ml-0.5 text-xs text-red-600" title="USD funding bind — target trimmed">⛓</span>}</>}
                  formula={fFormula('targetNpCash')} defaultFormula={SIM_FIELD_BY_KEY.targetNpCash.defaultFormula}
                  onCommit={fCommit('targetNpCash')} error={fErr('targetNpCash')} title="Target NP Cash = Opening NP + Swap"
                  columnKey="targetNpCash" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-amber-100 font-semibold ${clr(fv('targetNpCashUSD'))}`}
                  display={<>{fmtThresholdUsd(fv('targetNpCashUSD'))}{r.debit_floor_binding && <span className="ml-0.5 text-xs text-amber-600" title="Expensive OD floor">⌊</span>}</>}
                  formula={fFormula('targetNpCashUSD')} defaultFormula={SIM_FIELD_BY_KEY.targetNpCashUSD.defaultFormula}
                  onCommit={fCommit('targetNpCashUSD')} error={fErr('targetNpCashUSD')} title="Target NP Cash $USD"
                  columnKey="targetNpCashUSD" rowKey={r.ccy} />

                {/* SWAP */}
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-50 border-l border-gray-300 font-semibold ${clr(fv('swapNear'))}`}
                  display={f2(fv('swapNear'))}
                  formula={fFormula('swapNear')} defaultFormula={SIM_FIELD_BY_KEY.swapNear.defaultFormula}
                  onCommit={fCommit('swapNear')} error={fErr('swapNear')} title="Swap near leg (model-optimised; override to force a value)"
                  columnKey="swapNear" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-100 font-semibold ${clr(fv('swapUSD'))}`}
                  display={fmtSwapUsd(fv('swapUSD'))}
                  formula={fFormula('swapUSD')} defaultFormula={SIM_FIELD_BY_KEY.swapUSD.defaultFormula}
                  onCommit={fCommit('swapUSD')} error={fErr('swapUSD')} title="Swap $USD"
                  columnKey="swapUSD" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-50 font-medium ${clr(fv('npSwap'))}`}
                  display={f2(fv('npSwap'))}
                  formula={fFormula('npSwap')} defaultFormula={SIM_FIELD_BY_KEY.npSwap.defaultFormula}
                  onCommit={fCommit('npSwap')} error={fErr('npSwap')} title="NP+Swap = Opening NP + Swap"
                  columnKey="npSwap" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-100 font-medium ${clr(fv('npSwapUSD'))}`}
                  display={fmtSwapUsd(fv('npSwapUSD'))}
                  formula={fFormula('npSwapUSD')} defaultFormula={SIM_FIELD_BY_KEY.npSwapUSD.defaultFormula}
                  onCommit={fCommit('npSwapUSD')} error={fErr('npSwapUSD')} title="NP+Swap $USD"
                  columnKey="npSwapUSD" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-50 font-medium ${clr(fv('cycleEnd'))}`}
                  display={f2(fv('cycleEnd'))}
                  formula={fFormula('cycleEnd')} defaultFormula={SIM_FIELD_BY_KEY.cycleEnd.defaultFormula}
                  onCommit={fCommit('cycleEnd')} error={fErr('cycleEnd')} title="Cycle End cash"
                  columnKey="cycleEnd" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-100 font-medium ${clr(fv('cycleEndUSD'))}`}
                  display={fmtSwapUsd(fv('cycleEndUSD'))}
                  formula={fFormula('cycleEndUSD')} defaultFormula={SIM_FIELD_BY_KEY.cycleEndUSD.defaultFormula}
                  onCommit={fCommit('cycleEndUSD')} error={fErr('cycleEndUSD')} title="Cycle End $USD"
                  columnKey="cycleEndUSD" rowKey={r.ccy} />

                {/* FX HEDGE — strategy-driven fwd / option legs (editable) */}
                <FormulaCell
                  tdClass={`${tdBase} bg-rose-50 border-l-2 border-rose-400 font-semibold ${
                    Math.abs(fv('fwdHedgeUSD')) < 0.005 ? 'text-gray-300' : fv('fwdHedgeUSD') < 0 ? 'text-red-600' : 'text-green-700'}`}
                  display={Math.abs(fv('fwdHedgeUSD')) < 0.005 ? '—' : f2(fv('fwdHedgeUSD'))}
                  formula={fFormula('fwdHedgeUSD')} defaultFormula={SIM_FIELD_BY_KEY.fwdHedgeUSD.defaultFormula}
                  onCommit={fCommit('fwdHedgeUSD')} error={fErr('fwdHedgeUSD')}
                  title="Fwd Hedge $USD — forward notional × spot"
                  columnKey="fwdHedgeUSD" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-rose-50 font-semibold ${
                    Math.abs(fv('optionHedgeUSD')) < 0.005 ? 'text-gray-300' : fv('optionHedgeUSD') < 0 ? 'text-red-600' : 'text-green-700'}`}
                  display={Math.abs(fv('optionHedgeUSD')) < 0.005 ? '—' : (
                    <>
                      {r.optType && (
                        <span className={`mr-1 rounded px-1 text-[10px] font-bold ${r.optType === 'SELL_CALL' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}`}>
                          {r.optType === 'SELL_CALL' ? 'sC' : 'sP'}
                        </span>
                      )}
                      {f2(fv('optionHedgeUSD'))}
                    </>
                  )}
                  formula={fFormula('optionHedgeUSD')} defaultFormula={SIM_FIELD_BY_KEY.optionHedgeUSD.defaultFormula}
                  onCommit={fCommit('optionHedgeUSD')} error={fErr('optionHedgeUSD')}
                  title="Option Hedge $USD — δ × option notional × spot"
                  columnKey="optionHedgeUSD" rowKey={r.ccy} />
                <td className={`${tdBase} bg-rose-50 text-center`}
                  title={strategy !== 'SWAP_FWD_OPT'
                    ? 'Option delta — select "Swap + Fwd + Option" strategy above to activate the written option'
                    : 'Option delta (ATM ≈ 0.5) — editable regardless of current forward size; takes effect once this row has a non-zero forecast to hedge'}>
                  <input
                    type="text" inputMode="decimal"
                    disabled={strategy !== 'SWAP_FWD_OPT'}
                    value={drafts[`${r.id}.hedgeDelta`] ?? (hedgeDeltas[r.id] ?? 0.5)}
                    onChange={e => {
                      setDrafts(prev => ({ ...prev, [`${r.id}.hedgeDelta`]: e.target.value }));
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v >= 0 && v <= 1) setHedgeDeltas(prev => ({ ...prev, [r.id]: v }));
                    }}
                    onBlur={() => setDrafts(prev => { const next = { ...prev }; delete next[`${r.id}.hedgeDelta`]; return next; })}
                    className={`${inBase} w-[36px] font-medium ${
                      strategy !== 'SWAP_FWD_OPT' ? 'text-gray-300 cursor-not-allowed' : 'text-rose-700'
                    }`}
                  />
                </td>
                <td className={`${tdBase} bg-rose-100 font-medium ${
                  Math.abs(hedgeCarry) < 0.005 ? 'text-gray-300'
                    : hedgeCarry >= 0 ? 'text-green-700' : 'text-red-600'
                }`}
                  title={`Fwd points $${f2(r.fwdCarryUsdYr)} + option δ-leg points $${f2(r.optCarryUsdYr)} = $${f2(hedgeCarry)}M/yr USD. Gross premium harvested $${f2(r.optPremiumUsdYr)}M/yr shown for reference — excluded from carry (offsets expected exercise cost at fair value)`}>
                  {usdCarry(hedgeCarry)}
                </td>
                <td className={`${tdBase} bg-rose-100 font-medium ${
                  Math.abs(residual) < 0.005 ? 'text-green-700' : clr(residual)
                }`}
                  title={`Net FX Forecast (${f2(r.netFxForecast)} M ${r.ccy}, incl. current book) + hedge legs = ${f2(residual)} M ${r.ccy} unhedged × spot = $${f2(swapNearUsd(r.ccy, residual))} USD M`}>
                  {Math.abs(residual) < 0.005 ? '✓ 0.00' : f2(swapNearUsd(r.ccy, residual))}
                </td>
</>)}

                {showRiskMetrics && (() => {
                  const rm = riskMetricsByCcy[r.ccy];
                  const exp = rm?.exposureLocalM ?? 0;
                  const spotH = rm?.spotHedgeLocalM ?? 0;
                  const fwdH = rm?.forwardHedgeLocalM ?? 0;
                  const resid = rm?.residualLocalM ?? exp;
                  const v = rm?.varUsdM ?? 0;
                  const vBefore = rm?.varBeforeUsdM ?? v;
                  const fmtSigned = (n: number) => `${n >= 0 ? '+' : ''}${f2(n)}`;
                  return (
                    <>
                      <td
                        className={`${tdBase} bg-violet-50 border-l border-violet-300 font-mono ${
                          exp >= 0 ? 'text-emerald-700' : 'text-rose-600'
                        }`}
                        title={`Unhedged Analytics exposure · VaR before $${(vBefore * 1000).toFixed(0)}K`}
                      >
                        {fmtSigned(exp)}
                      </td>
                      <td
                        className={`${tdBase} bg-emerald-50 font-mono ${
                          Math.abs(spotH) < 1e-9
                            ? 'text-gray-300'
                            : spotH >= 0
                              ? 'text-emerald-700'
                              : 'text-rose-600'
                        }`}
                        title="Spot hedge notional (M FCY) — Decision layer bookings + incremental stock %"
                      >
                        {Math.abs(spotH) < 1e-9 ? '—' : fmtSigned(spotH)}
                      </td>
                      <td
                        className={`${tdBase} bg-emerald-50 font-mono ${
                          Math.abs(fwdH) < 1e-9
                            ? 'text-gray-300'
                            : fwdH >= 0
                              ? 'text-emerald-700'
                              : 'text-rose-600'
                        }`}
                        title="Forward hedge notional (M FCY) — Decision layer bookings + incremental avg-buildup %"
                      >
                        {Math.abs(fwdH) < 1e-9 ? '—' : fmtSigned(fwdH)}
                      </td>
                      <td
                        className={`${tdBase} bg-violet-50 font-mono ${
                          Math.abs(resid) < 1e-9
                            ? 'text-emerald-700'
                            : resid >= 0
                              ? 'text-emerald-700'
                              : 'text-rose-600'
                        }`}
                        title="Residual = Exp − Spot hedge − Fwd hedge"
                      >
                        {Math.abs(resid) < 1e-9 ? '✓ 0.00' : fmtSigned(resid)}
                      </td>
                      <td
                        className={`${tdBase} bg-violet-100 font-semibold font-mono text-violet-900`}
                        title={`VaR on residual · ${varRegimeLabel} (unhedged $${(vBefore * 1000).toFixed(0)}K)`}
                      >
                        ${(v * 1000).toFixed(0)}K
                      </td>
                    </>
                  );
                })()}

                {showPnl && (<>
                {/* P&L — all five columns below are USD-denominated ($M/yr) */}
                <td className={`${tdBase} bg-purple-50 border-l border-gray-300 font-semibold ${clr(swapNearUsd(r.ccy, r.netDelta))}`}
                  title={`Net FX delta ${f2(r.netDelta)} M ${r.ccy} × spot ${(CURRENCY_PARAMS[r.ccy]?.spot ?? 1).toFixed(4)} = $${f2(swapNearUsd(r.ccy, r.netDelta))} USD M`}>
                  ${f2(swapNearUsd(r.ccy, r.netDelta))}
                </td>
                <td className={`${tdBase} bg-purple-50 font-medium ${r.floatNim >= 0 ? 'text-green-700' : 'text-red-600'}`}
                  title={`Post-swap economic cash carry (USD): NP+Swap ${f2(r.postSwapCash)}M ${r.ccy} × spot × (${r.postSwapCash >= 0 ? `credit ${r.r_FCY.toFixed(2)}%` : `debit ${r.r_OD.toFixed(2)}%`} − r_USD ${shared.r_USD.toFixed(2)}%) / 100 = $${f2(r.floatNim)}M/yr. Opening cash swapped away is not counted — CIP cancels that differential through the swap points.`}>
                  {usdCarry(r.floatNim, 0)}
                </td>
                <td className={`${tdBase} bg-purple-50 font-medium ${
                  Math.abs(r.swapCarryUsdYr) < 0.005 ? 'text-gray-300'
                    : r.swapCarryUsdYr >= 0 ? 'text-green-700' : 'text-red-600'
                }`}
                  title="FX swap at mid vs term SOFR is CIP carry-neutral: earn/pay on the moved FCY notional is cancelled by the opposite swap points P&L. Economic carry sits entirely in Cash Carry on the post-swap balance.">
                  {usdCarry(r.swapCarryUsdYr)}
                </td>
                <td className={`${tdBase} bg-purple-50 font-medium ${
                  Math.abs(hedgeCarry) < 0.005 ? 'text-gray-300'
                    : hedgeCarry >= 0 ? 'text-green-700' : 'text-red-600'
                }`}
                  title="FX hedge carry (USD) — same value as Hedge Carry in the FX HEDGE section">
                  {usdCarry(hedgeCarry)}
                </td>
                <td className={`${tdBase} bg-purple-100 font-semibold ${
                  (r.floatNim + r.swapCarryUsdYr + (R?.hedgeCarryUsdYr ?? r.hedgeCarryUsdYr)) >= 0 ? 'text-emerald-700' : 'text-red-600'
                }`}
                  title="Total annual USD carry = post-swap Cash Carry (CIP-neutral swap → Swap Carry 0) + Hedge Carry">
                  {usdCarry(r.floatNim + r.swapCarryUsdYr + (R?.hedgeCarryUsdYr ?? r.hedgeCarryUsdYr), 0)}
                </td>
                </>)}
              </tr>
              );
            })}

            {/* ── USD row ── */}
            <tr className="border-t-2 border-blue-400 bg-blue-50/40 font-medium">
              <td className="sticky left-0 z-20 bg-blue-100 px-1.5 py-0.5 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]">
                <span className="text-xs font-bold text-blue-800 px-0.5">USD</span>
              </td>

              {/* RATES */}
              {ratesOn && (<>
              <td className={`${tdBase} bg-gray-50 border-l border-gray-300`}>
                <input type="text" inputMode="decimal" value={drafts['usd.r_FCY'] ?? usdParams.r_FCY}
                  onChange={e => editUsd('r_FCY', e.target.value)}
                  onBlur={() => blurUsd('r_FCY')}
                  className={`${inBase} w-[52px]`} />
              </td>
              <td className={`${tdBase} bg-gray-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.r_OD'] ?? usdParams.r_OD}
                  onChange={e => editUsd('r_OD', e.target.value)}
                  onBlur={() => blurUsd('r_OD')}
                  className={`${inBase} w-[52px]`} />
              </td>
              <td className={`${tdBase} bg-gray-50 font-medium ${dclr(usdComputed.delta_r)}`}>
                {usdComputed.delta_r > 0 ? '+' : ''}{f2(usdComputed.delta_r)}%
              </td>
              </>)}

              {/* FX POSITION — USD balancing leg */}
              {showFxPosition && (<>
              <td className={`${tdBase} bg-white border-l border-gray-300 text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxSpotUSD)}`}>{f2(usdComputed.fxSpotUSD)}</td>
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxFwdUSD)}`}>{f2(usdComputed.fxFwdUSD)}</td>
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxNonCashAssetUSD)}`}
                title="USD is the balancing leg — nets the Σ non-cash asset FX across all FCY rows">{f2(usdComputed.fxNonCashAssetUSD)}</td>
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxNonCashUSD)}`}>{f2(usdComputed.fxNonCashUSD)}</td>
              {simplifiedFx && (<>
              <td className={`${tdBase} bg-white`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_liab_notional'] ?? usdParams.ir_liab_notional}
                  onChange={e => editUsd('ir_liab_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_notional')}
                  className={`${inBase} w-[58px] ${usdParams.ir_liab_notional < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-white`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_liab_notional'] ?? usdParams.ir_liab_notional}
                  onChange={e => editUsd('ir_liab_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_notional')}
                  className={`${inBase} w-[62px] font-medium ${usdParams.ir_liab_notional < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-white`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_invest_notional'] ?? (usdParams.ir_invest_notional ?? 0)}
                  onChange={e => editUsd('ir_invest_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_notional')}
                  className={`${inBase} w-[58px] ${(usdParams.ir_invest_notional ?? 0) < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-white`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_invest_notional'] ?? (usdParams.ir_invest_notional ?? 0)}
                  onChange={e => editUsd('ir_invest_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_notional')}
                  className={`${inBase} w-[62px] font-medium ${(usdParams.ir_invest_notional ?? 0) < 0 ? 'text-red-600' : ''}`} />
              </td>
              </>)}
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.netFxUSD)}`}>{f2(usdComputed.netFxUSD)}</td>
              <td className={`${tdBase} bg-white font-medium ${Math.abs(usdComputed.netFxForecast) < 0.005 ? 'text-gray-400' : clr(usdComputed.netFxForecast)}`}
                title={`USD Payins (${f2(usdComputed.collections)}) + Payouts (${f2(usdComputed.payout)}) = ${f2(usdComputed.netFxForecast)} M USD`}>
                {Math.abs(usdComputed.netFxForecast) < 0.005 ? '—' : f2(usdComputed.netFxForecast)}
              </td>
              <td className={`${tdBase} bg-white font-medium ${Math.abs(usdComputed.netFxForecast) < 0.005 ? 'text-gray-400' : clr(usdComputed.netFxForecast)}`}>
                {Math.abs(usdComputed.netFxForecast) < 0.005 ? '—' : f2(usdComputed.netFxForecast)}
              </td>
              </>)}

              {/* LIQUIDITY */}
              {showLiquidity && (<>
              <td className={`${tdBase} bg-sky-50 border-l border-sky-200`}>
                <input type="text" inputMode="decimal" value={drafts['usd.cash'] ?? usdCash}
                  onChange={e => {
                    setDrafts(prev => ({ ...prev, 'usd.cash': e.target.value }));
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) setUsdCash(v);
                  }}
                  onBlur={() => setDrafts(prev => { const next = { ...prev }; delete next['usd.cash']; return next; })}
                  className={`${inBase} w-[58px] ${usdCash < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-sky-100 font-medium ${clr(usdComputed.cash)}`}>{f2(usdComputed.cash)}</td>
              <td className={`${tdBase} bg-sky-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.payout'] ?? usdParams.payout}
                  onChange={e => editUsd('payout', e.target.value)}
                  onBlur={() => blurUsd('payout')}
                  className={`${inBase} w-[62px] ${usdParams.payout < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-sky-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.collections'] ?? usdParams.collections}
                  onChange={e => editUsd('collections', e.target.value)}
                  onBlur={() => blurUsd('collections')}
                  className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-sky-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.nonNpCash'] ?? usdNonNpCash}
                  onChange={e => {
                    setDrafts(prev => ({ ...prev, 'usd.nonNpCash': e.target.value }));
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) setUsdNonNpCash(v);
                  }}
                  onBlur={() => setDrafts(prev => { const next = { ...prev }; delete next['usd.nonNpCash']; return next; })}
                  className={`${inBase} w-[58px] ${usdNonNpCash < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-sky-100 font-semibold ${
                usdComputed.np_peak_cash >= usdComputed.cash_threshold ? 'text-green-700'
                : usdComputed.np_peak_cash >= 0               ? 'text-amber-700'
                : 'text-red-600'
              }`}>{f2(usdComputed.np_peak_cash)}</td>
              <td className={`${tdBase} bg-sky-100 font-medium ${
                usdComputed.cash_after_payins >= 0 ? 'text-green-700' : 'text-red-600'
              }`}
                title={`NP (${f2(usdComputed.cash)}) + Non-NP (${f2(usdComputed.nonNpCash)}) + Payouts (${f2(usdComputed.payout)}) + Payins (${f2(usdComputed.collections)}) = ${f2(usdComputed.cash_after_payins)} M USD — before swap`}>
                {f2(usdComputed.cash_after_payins)}
              </td>
              <td className={`${tdBase} bg-sky-50 font-medium ${clr(usdComputed.cashPos)}`}>{f2(usdComputed.cashPos)}</td>
              <td className={`${tdBase} bg-sky-100 font-medium ${clr(usdComputed.cashPosUSD)}`}>{f2(usdComputed.cashPosUSD)}</td>
              </>)}

              {/* IR / FIXED-RATE BOOK — USD */}
              {showBonds && (<>
              <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_asset_notional'] ?? usdParams.ir_asset_notional}
                  onChange={e => editUsd('ir_asset_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_asset_notional')}
                  className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-rose-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_asset_rate'] ?? usdParams.ir_asset_rate}
                  onChange={e => editUsd('ir_asset_rate', e.target.value)}
                  onBlur={() => blurUsd('ir_asset_rate')}
                  className={`${inBase} w-[46px]`} />
              </td>
              </>)}
              {showInvestments && (<>
              <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_invest_notional'] ?? (usdParams.ir_invest_notional ?? 0)}
                  onChange={e => editUsd('ir_invest_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_notional')}
                  className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-rose-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_invest_rate'] ?? (usdParams.ir_invest_rate ?? 0)}
                  onChange={e => editUsd('ir_invest_rate', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_rate')}
                  className={`${inBase} w-[46px]`} />
              </td>
              </>)}
              {showLiabilities && (<>
              <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_liab_notional'] ?? usdParams.ir_liab_notional}
                  onChange={e => editUsd('ir_liab_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_notional')}
                  className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-rose-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_liab_rate'] ?? usdParams.ir_liab_rate}
                  onChange={e => editUsd('ir_liab_rate', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_rate')}
                  className={`${inBase} w-[46px]`} />
              </td>
              </>)}

              {/* CARRY / BUFFER */}
{showAdvancedBook && (<>
              <td className={`${tdBase} bg-amber-50 border-l border-gray-300 text-center`}>
                <CarryBadge dir={usdComputed.carryDir} />
              </td>
              <td className={`${tdBase} bg-amber-50 font-semibold text-amber-900`}
                title={`Opening NP ($${f2(usdComputed.cash)}) + Swap ($${f2(usdComputed.swapNear)}) = $${f2(usdComputed.cash_threshold)}M · payout reserve H* $${f2(usdComputed.cash_threshold_pre_swap)}M${usdComputed.funding_binding ? ' — USD funding bind' : ''}`}>
                {f2(usdComputed.cash_threshold)}
                {usdComputed.funding_binding && (
                  <span className="ml-0.5 text-xs text-red-600" title="USD funding bind">⛓</span>
                )}
              </td>
              <td className={`${tdBase} bg-amber-100 font-semibold text-amber-900`}
                title={`USD Target = opening NP + swap = ${fmtThresholdUsd(usdComputed.cashThresholdUSD)}`}>
                {fmtThresholdUsd(usdComputed.cashThresholdUSD)}
                {usdComputed.funding_binding && (
                  <span className="ml-0.5 text-xs text-red-600" title="USD funding bind">⛓</span>
                )}
              </td>

              {/* SWAP */}
              <td className={`${tdBase} bg-emerald-50 border-l border-gray-300 font-semibold ${clr(usdComputed.swapNear)}`}
                title="USD funding leg (already in $M)">
                {f2(usdComputed.swapNear)}
              </td>
              <td className={`${tdBase} bg-emerald-100 font-semibold ${clr(usdComputed.swapNear)}`}
                title="USD funding leg — offsets Σ(FCY swap × spot)">
                {fmtSwapUsd(usdComputed.swapNear)}
              </td>
              <td className={`${tdBase} bg-emerald-50 font-medium ${clr(usdComputed.postSwapCash)}`}
                title={`Opening NP ($${f2(usdComputed.cash)}) + Swap ($${f2(usdComputed.swapNear)}) = $${f2(usdComputed.postSwapCash)}M — funded position before payout`}>
                {f2(usdComputed.postSwapCash)}
              </td>
              <td className={`${tdBase} bg-emerald-100 font-medium ${clr(usdComputed.postSwapUSD)}`}
                title="Opening NP $USD + Swap $USD at near leg">
                {fmtSwapUsd(usdComputed.postSwapUSD)}
              </td>
              <td className={`${tdBase} bg-emerald-50 font-medium ${clr(usdComputed.cycleEndCash)}`}
                title={`NP+Swap ($${f2(usdComputed.postSwapCash)}) + Payout ($${f2(usdComputed.payout)}) + Payins ($${f2(usdComputed.collections)}) + Non-NP sweep ($${f2(usdComputed.nonNpCash)}) = $${f2(usdComputed.cycleEndCash)}M`}>
                {f2(usdComputed.cycleEndCash)}
              </td>
              <td className={`${tdBase} bg-emerald-100 font-medium ${clr(usdComputed.cycleEndCash)}`}
                title="Cycle Net Flow $USD + Swap $USD — before far leg">
                {fmtSwapUsd(usdComputed.cycleEndCash)}
              </td>

              {/* FX HEDGE — USD is the settlement leg of all FCY hedges */}
              <td className={`${tdBase} bg-rose-50 border-l-2 border-rose-400 font-semibold ${Math.abs(hedgeTotals.fwdUSD) < 0.005 ? 'text-gray-400' : clr(-hedgeTotals.fwdUSD)}`}
                title="USD settlement leg of all FCY forwards = −Σ(fwd × spot)">
                {Math.abs(hedgeTotals.fwdUSD) < 0.005 ? '—' : fmtSwapUsd(-hedgeTotals.fwdUSD)}
              </td>
              <td className={`${tdBase} bg-rose-50 font-semibold ${Math.abs(hedgeTotals.optUSD) < 0.005 ? 'text-gray-400' : clr(-hedgeTotals.optUSD)}`}
                title="USD settlement leg of all FCY options, delta-effective = −Σ(δ × written notional × spot)">
                {Math.abs(hedgeTotals.optUSD) < 0.005 ? '—' : fmtSwapUsd(-hedgeTotals.optUSD)}
              </td>
              <td className={`${tdBase} bg-rose-50 text-center text-gray-400`}>—</td>
              <td className={`${tdBase} bg-rose-100 font-bold ${
                Math.abs(hedgeTotals.hedgeCarryUsdYr) < 0.005 ? 'text-gray-400'
                  : hedgeTotals.hedgeCarryUsdYr >= 0 ? 'text-green-700' : 'text-red-600'
              }`}>
                {usdCarry(hedgeTotals.hedgeCarryUsdYr)}
              </td>
              <td className={`${tdBase} bg-rose-100 text-gray-400 text-xs`}>USD offset</td>
</>)}

              {showRiskMetrics && (
                <>
                  <td className={`${tdBase} bg-violet-50 border-l border-violet-300 text-gray-400 text-xs`}>—</td>
                  <td className={`${tdBase} bg-emerald-50 text-gray-400 text-xs`}>—</td>
                  <td className={`${tdBase} bg-emerald-50 text-gray-400 text-xs`}>—</td>
                  <td className={`${tdBase} bg-violet-50 text-gray-400 text-xs`}>—</td>
                  <td className={`${tdBase} bg-violet-100 text-gray-400 text-xs`} title="Reporting CCY — no FX mismatch VaR">—</td>
                </>
              )}

              {showPnl && (<>
              {/* P&L */}
              <td className={`${tdBase} bg-purple-50 border-l border-gray-300 font-semibold ${clr(usdComputed.netDelta)}`}>${f2(usdComputed.netDelta)}</td>
              <td className={`${tdBase} bg-purple-50 font-medium ${usdComputed.floatNim >= 0 ? 'text-green-700' : 'text-red-600'}`} title="USD is the base currency — Δr = 0, no carry vs itself">{usdCarry(usdComputed.floatNim, 0)}</td>
              <td className={`${tdBase} bg-purple-50 text-gray-400 text-xs`} title="USD is the funding leg — its interest effect is inside each FCY swap carry">—</td>
              <td className={`${tdBase} bg-purple-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-purple-100 text-gray-400 text-xs`}>—</td>
              </>)}
            </tr>

            {/* ── Totals row ── */}
            <tr className="border-t-2 border-gray-400 bg-gray-100 font-semibold">
              <td className="sticky left-0 z-20 bg-gray-100 px-2 py-1 text-xs font-bold text-gray-700 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.12)]">TOTAL</td>

              {/* RATES — blank */}
              {ratesOn && (
                <td className="bg-gray-50 border-l border-gray-300" colSpan={3} />
              )}

              {/* FX POSITION — FCY not additive; validate $USD columns */}
              {showFxPosition && (<>
              <td className={`${tdBase} bg-white border-l border-gray-300 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} font-bold border border-gray-300 ${zeroSumCls(fxUsdTotals.spot)}`}
                title="Σ Spot $USD across all CCY + USD — must equal 0">
                {fmtZeroSumUsd(fxUsdTotals.spot)}
              </td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} font-bold border border-gray-300 ${zeroSumCls(fxUsdTotals.fwd)}`}
                title="Σ Fwd $USD across all CCY + USD — must equal 0">
                {fmtZeroSumUsd(fxUsdTotals.fwd)}
              </td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} font-bold border border-gray-300 ${zeroSumCls(fxUsdTotals.nonCashAsset)}`}
                title="Σ Non-Cash Asset $USD across all CCY + USD — must equal 0">
                {fmtZeroSumUsd(fxUsdTotals.nonCashAsset)}
              </td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} font-bold border border-gray-300 ${zeroSumCls(fxUsdTotals.nonCash)}`}
                title="Σ Non-Cash $USD across all CCY + USD — must equal 0">
                {fmtZeroSumUsd(fxUsdTotals.nonCash)}
              </td>
              {simplifiedFx && (<>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              </>)}
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} font-bold border border-gray-300 ${zeroSumCls(fxUsdTotals.netFx)}`}
                title="Σ Net FX $USD across all CCY + USD — must equal 0">
                {fmtZeroSumUsd(fxUsdTotals.netFx)}
              </td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`} title="M FCY forecasts are not additive across currencies">—</td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`} title="M FCY forecasts are not additive across currencies">—</td>
              </>)}

              {/* LIQUIDITY — M FCY not additive; $USD columns summed */}
              {showLiquidity && (<>
              <td className={`${tdBase} bg-sky-50 border-l border-sky-200 text-gray-400 text-xs`} title="M FCY balances are not additive across currencies">—</td>
              <td className={`${tdBase} bg-sky-100 font-bold ${clr(npCashUsdTotal)}`}
                title="Σ NP Cash $USD across all CCY + USD">
                {f2(npCashUsdTotal)}
              </td>
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-100 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-100 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-100 font-bold border border-sky-300 ${zeroSumCls(fxUsdTotals.cashPos)}`}
                title="Σ Total Cash $USD (NP + Non-NP) across all CCY + USD">
                {fmtZeroSumUsd(fxUsdTotals.cashPos)}
              </td>
              </>)}

              {/* IR / FIXED-RATE BOOK — M FCY not additive across currencies */}
              {showIrBook && (
                <td className="bg-rose-50 border-l border-rose-200 text-gray-400 text-xs text-center" colSpan={irCols}>—</td>
              )}

{showAdvancedBook && (<>
              {/* CARRY / BUFFER */}
              <td className="bg-amber-50 border-l border-gray-300" />
              <td className={`${tdBase} bg-amber-50 text-gray-400 text-xs`} title="M FCY thresholds are not additive across currencies">—</td>
              <td className={`${tdBase} bg-amber-100 font-bold ${clr(thresholdUsdTotal)}`}>{fmtThresholdUsd(thresholdUsdTotal)}</td>

              {/* SWAP — FCY units not additive; validate in $USD column */}
              <td className={`${tdBase} bg-emerald-50 border-l border-gray-300 text-gray-400 text-xs`} title="M FCY swap legs are not additive across currencies">—</td>
              <td className={`${tdBase} font-bold border border-emerald-300 ${
                Math.abs(swapNearUsdTotal) < 0.01 ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'
              }`}
                title="Σ (swap × spot) across all CCY + USD — must equal 0">
                {Math.abs(swapNearUsdTotal) < 0.01
                  ? <><span className="mr-1">✓</span>{f2(0)}<span className="ml-1 text-xs font-normal">zero-sum</span></>
                  : <><span className="mr-1">⚠</span>{fmtSwapUsd(swapNearUsdTotal)}</>}
              </td>
              <td className={`${tdBase} bg-emerald-50 text-gray-400 text-xs`} title="M FCY NP after swap is not additive across currencies">—</td>
              <td className={`${tdBase} bg-emerald-100 font-bold border border-emerald-200 ${clr(postSwapUsdTotal)}`}
                title={`Σ (Opening NP + Swap) $USD — swap zero-sum, so = Σ opening NP $USD`}>
                {fmtSwapUsd(postSwapUsdTotal)}
              </td>
              <td className={`${tdBase} bg-emerald-50 text-gray-400 text-xs`} title="M FCY cycle end is not additive across currencies">—</td>
              <td className={`${tdBase} bg-emerald-100 font-bold border border-emerald-200 ${clr(cycleEndUsdTotal)}`}
                title={`Σ Cycle End $USD (NP+Swap − payout + payins + Non-NP sweep) — before far leg`}>
                {fmtSwapUsd(cycleEndUsdTotal)}
              </td>

              {/* FX HEDGE totals — 5 cols: fwd, option, δ, hedge carry, residual */}
              <td className={`${tdBase} bg-rose-50 border-l-2 border-rose-400 font-bold ${Math.abs(hedgeTotals.fwdUSD) < 0.005 ? 'text-gray-400 text-xs font-normal' : clr(hedgeTotals.fwdUSD)}`}
                title="Σ forward notionals in $USD across all FCY rows">
                {Math.abs(hedgeTotals.fwdUSD) < 0.005 ? '—' : fmtSwapUsd(hedgeTotals.fwdUSD)}
              </td>
              <td className={`${tdBase} bg-rose-50 font-bold ${Math.abs(hedgeTotals.optUSD) < 0.005 ? 'text-gray-400 text-xs font-normal' : clr(hedgeTotals.optUSD)}`}
                title="Σ delta-effective option hedges (δ × written notional) in $USD across all FCY rows">
                {Math.abs(hedgeTotals.optUSD) < 0.005 ? '—' : fmtSwapUsd(hedgeTotals.optUSD)}
              </td>
              <td className={`${tdBase} bg-rose-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-rose-100 font-bold ${
                Math.abs(hedgeTotals.hedgeCarryUsdYr) < 0.005 ? 'text-gray-400 text-xs font-normal'
                  : hedgeTotals.hedgeCarryUsdYr >= 0 ? 'text-green-700' : 'text-red-600'
              }`}
                title="Σ FX hedge carry across all rows ($M/yr USD): fwd points + option δ-leg delivery points; gross option premium excluded (offsets expected exercise cost at fair value)">
                {hedgeTotals.hedgeCarryUsdYr === 0 ? '—' : `${usdCarry(hedgeTotals.hedgeCarryUsdYr)}/yr`}
              </td>
              <td className={`${tdBase} bg-rose-100 font-bold ${Math.abs(hedgeTotals.residUSD) < 0.005 ? 'text-green-700' : clr(hedgeTotals.residUSD)}`}
                title="Σ residual (unhedged) FX exposure across all FCY rows, $USD M">
                {Math.abs(hedgeTotals.residUSD) < 0.005 ? '✓ 0.00' : fmtSwapUsd(hedgeTotals.residUSD)}
              </td>
</>)}

              {showRiskMetrics && (
                <>
                  <td className={`${tdBase} bg-violet-50 border-l border-violet-300 text-gray-400 text-xs`}>—</td>
                  <td
                    className={`${tdBase} bg-emerald-50 font-bold text-emerald-800`}
                    title="Σ |spot hedge| local M across FCY (not additive across currencies)"
                  >
                    {spotHedgeTotalLocal < 1e-9 ? '—' : f2(spotHedgeTotalLocal)}
                  </td>
                  <td
                    className={`${tdBase} bg-emerald-50 font-bold text-emerald-800`}
                    title="Σ |forward hedge| local M across FCY (not additive across currencies)"
                  >
                    {fwdHedgeTotalLocal < 1e-9 ? '—' : f2(fwdHedgeTotalLocal)}
                  </td>
                  <td className={`${tdBase} bg-violet-50 text-gray-400 text-xs`}>—</td>
                  <td
                    className={`${tdBase} bg-violet-100 font-bold text-violet-900`}
                    title={`Σ undiversified VaR after hedges · ${varRegimeLabel}`}
                  >
                    ${(varTotalUsdM * 1000).toFixed(0)}K
                  </td>
                </>
              )}

              {showPnl && (<>
              {/* P&L — all five totals below are USD-denominated ($M/yr); Net Delta $USD is additive across currencies */}
              <td className={`${tdBase} bg-purple-50 border-l border-gray-300 font-bold ${clr(netDeltaUsdTotal)}`}
                title="Σ net FX delta across all rows, converted to $USD at spot">
                ${f2(netDeltaUsdTotal)}
              </td>
              <td className={`${tdBase} bg-purple-50 font-bold ${floatNimUsdTotal >= 0 ? 'text-green-700' : 'text-red-600'}`}
                title="Σ post-swap economic cash carry across all rows, $M/yr USD — O/N earn/pay on the funded NP balance after CIP-neutral swaps">
                {usdCarry(floatNimUsdTotal, 0)}
              </td>
              <td className={`${tdBase} bg-purple-50 font-bold ${swapCarryTotal >= 0 ? 'text-green-700' : 'text-red-600'}`}
                title="Σ swap P&L — identically 0 under CIP (cancelled into Cash Carry on the post-swap balance)">
                {usdCarry(swapCarryTotal, 0)}
              </td>
              <td className={`${tdBase} bg-purple-50 font-bold ${
                Math.abs(hedgeTotals.hedgeCarryUsdYr) < 0.005 ? 'text-gray-400 text-xs font-normal'
                  : hedgeTotals.hedgeCarryUsdYr >= 0 ? 'text-green-700' : 'text-red-600'
              }`}
                title="Σ FX hedge carry across all rows, $M/yr USD — counted separately">
                {usdCarry(hedgeTotals.hedgeCarryUsdYr)}
              </td>
              <td className={`${tdBase} bg-purple-100 font-bold border border-purple-200 ${totalCarryUsd >= 0 ? 'text-emerald-700' : 'text-red-600'}`}
                title="Total annual USD carry = cash float + swap interest + FX hedge uplift">
                {usdCarry(totalCarryUsd, 0)}
                <span className="text-gray-400 ml-0.5 text-xs">M/yr</span>
              </td>
              </>)}
            </tr>
          </tbody>
        </table>
        </FormulaGridProvider>
      </div>
    </div>
  );
}
