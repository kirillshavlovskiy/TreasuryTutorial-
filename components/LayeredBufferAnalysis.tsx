'use client';

import { useState, useMemo, useEffect } from 'react';
import {
  CURRENCY_PARAMS,
  computePortfolioVAR,
  computeFcyCollateralBudget,
  sumFcySwapNearUsd,
  usdToFcyM,
  normInv,
  Z_NEUTRAL,
  FORECAST_ACCURACY_LAYERS,
  toggleLayerGroup,
  type LayerId,
  type PortfolioVARInput,
  type RowState,
  type SharedGlobals,
} from '@/lib/fx-buffer';
import type { LayerTargetRow } from '@/lib/dashboard-model';
import { DeskStepper } from '@/components/DeskStepper';

// ─── Layer definitions ────────────────────────────────────────────────────────

interface LayerDef {
  id: string;
  layers: readonly LayerId[];
  label: string;
  formula: string;
  hint: string;
  activeColor: string;
  textColor: string;
  bg: string;
}

const LAYER_DEFS: LayerDef[] = [
  {
    id: 'forecastAccuracy',
    layers: FORECAST_ACCURACY_LAYERS,
    label: 'Forecast accuracy',
    formula: 'Payout σ → H*',
    hint: 'Payout-σ sizes the funding swap. FX Net CFaR is USD P&L — not Swap Near.',
    activeColor: '#0ea5e9',
    textColor: 'text-sky-700',
    bg: 'bg-sky-50 border-sky-200',
  },
  {
    id: 'carryOptim',
    layers: ['carryOptim'],
    label: 'Carry Adjustment',
    formula: 'Rate-driven buffer shift',
    hint: 'EARN carry (LP rate > USD rate): holding more FCY earns money — buffer grows. PAY carry: holding FCY costs money — buffer shrinks to reduce opportunity cost.',
    activeColor: '#f59e0b',
    textColor: 'text-amber-700',
    bg: 'bg-amber-50 border-amber-200',
  },
  {
    id: 'floorH',
    layers: ['floorH'],
    label: 'Minimum Floor',
    formula: 'Hard cash minimum',
    hint: 'Enforces a minimum cash level regardless of carry calculation. Prevents buffer going to zero even for extreme PAY carry currencies.',
    activeColor: '#10b981',
    textColor: 'text-emerald-700',
    bg: 'bg-emerald-50 border-emerald-200',
  },
  {
    id: 'portfolioDiv',
    layers: ['portfolioDiv'],
    label: 'Portfolio VAR',
    formula: 'Cross-currency USD risk',
    hint: 'Carry overlay on |lp_cash|: PAY (CAD, JPY) → negative target (sell), EARN (MXN, GBP) → positive (buy). One scale factor sizes every currency to fill the portfolio VAR limit.',
    activeColor: '#8b5cf6',
    textColor: 'text-violet-700',
    bg: 'bg-violet-50 border-violet-200',
  },
];

// ─── Policy limit indicator ────────────────────────────────────────────────────

const POLICY_LIMITS = [
  { usd:  5.0, label: '$5M',  who: 'Dir. Finance', color: 'text-amber-600 bg-amber-50 border-amber-200' },
  { usd: 10.0, label: '$10M', who: 'CFO',           color: 'text-orange-600 bg-orange-50 border-orange-200' },
  { usd: 20.0, label: '$20M', who: 'CEO',           color: 'text-red-600 bg-red-50 border-red-200' },
];

function PolicyLimitBars({ varUSD }: { varUSD: number }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {POLICY_LIMITS.map(limit => {
        const hit = varUSD >= limit.usd;
        return (
          <span
            key={limit.usd}
            className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium
              ${hit ? limit.color : 'text-gray-300 bg-gray-50 border-gray-200'}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${hit ? 'bg-current' : 'bg-gray-300'}`} />
            {limit.label} ({limit.who})
          </span>
        );
      })}
      {varUSD < POLICY_LIMITS[POLICY_LIMITS.length - 1].usd && (
        <span className="text-xs text-green-600 font-medium">Within limits</span>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function f2(v: number) { return v.toFixed(2); }
function f3(v: number) { return v.toFixed(3); }
function signed(v: number) { return (v >= 0 ? '+' : '') + v.toFixed(2); }
function fM(v: number): string {
  const a = Math.abs(v);
  return (a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 0.1 ? v.toFixed(2) : v.toFixed(3));
}

function CarryBadge({ dir }: { dir: 'earn' | 'pay' | 'neutral' }) {
  if (dir === 'earn') return <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">EARN</span>;
  if (dir === 'pay')  return <span className="rounded-full bg-red-100  px-1.5 py-0.5 text-xs font-medium text-red-700">PAY</span>;
  return <span className="text-gray-300 text-xs">—</span>;
}

function NumInput({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void;
}) {
  // Local string state lets the user type freely (including intermediate states
  // like "" or "-") without the field snapping back on every keystroke.
  const [local, setLocal] = useState(String(value));

  // Sync when parent resets the value (e.g. a different control changes it)
  useEffect(() => { setLocal(String(value)); }, [value]);

  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-xs font-medium text-gray-600">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="number" step={step} min={min} max={max} value={local}
          onChange={e => {
            setLocal(e.target.value);
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) onChange(v);
          }}
          onBlur={() => {
            // On blur: if left blank/invalid, restore the last valid number
            if (isNaN(parseFloat(local))) setLocal(String(value));
          }}
          className="w-20 rounded border border-gray-300 px-2 py-1 text-xs text-right font-mono"
        />
        <span className="text-xs text-gray-400">{unit}</span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function LayeredBufferAnalysis({
  shared, onSharedChange, simRows, onRowFieldChange, activeLayers, onLayerToggle,
  layerRows,
  policyVAR, onPolicyVARChange,
  usdCash, usdPayout, usdNonLpCash = 0, onUsdCashChange, onUsdPayoutChange,
}: {
  shared: SharedGlobals;
  onSharedChange: (key: keyof SharedGlobals, value: number) => void;
  simRows: RowState[];
  onRowFieldChange: (ccy: string, field: keyof Omit<RowState, 'id' | 'ccy'>, value: number) => void;
  activeLayers: Set<LayerId>;
  onLayerToggle: (id: LayerId) => void;
  /** Precomputed layer targets from unified background calculation (page.tsx). */
  layerRows: LayerTargetRow[];
  policyVAR: number;
  onPolicyVARChange: (v: number) => void;
  /** USD LP cash ($M) — synced with FX Simulator USD row */
  usdCash: number;
  /** USD expected payout ($M, negative = outflow) — synced with FX Simulator */
  usdPayout: number;
  /** USD local/non-LP cash ($M) — synced with FX Simulator */
  usdNonLpCash?: number;
  onUsdCashChange: (v: number) => void;
  onUsdPayoutChange: (v: number) => void;
}) {
  // Draft strings for payout/cash/h_min cells — lets user type freely without snap-back
  const [cellDrafts, setCellDrafts] = useState<Record<string, string>>({});
  const [showCalcModal, setShowCalcModal] = useState(false);
  // View mode: FCY = native currency amounts | USD = all position columns × spot rate
  const [viewUSD, setViewUSD] = useState(false);

  // Layer toggles update activeLayers in the parent immediately — FX Simulator stays in sync.

  // Resolve effective payout/cash/rates for any currency:
  // — if the currency has a row in simRows, use that row's live values
  // — otherwise fall back to local overrides / defaults
  const getSimRow = (ccy: string) => simRows.find(r => r.ccy === ccy);

  const getPayout = (ccy: string) => {
    if (ccy === 'USD') return usdPayout;
    const sr = getSimRow(ccy);
    return sr ? sr.payout : 0;
  };
  const setPayout = (ccy: string, val: number) => {
    if (ccy === 'USD') { onUsdPayoutChange(val); return; }
    if (getSimRow(ccy)) onRowFieldChange(ccy, 'payout', val);
  };
  const getCash = (ccy: string) => {
    if (ccy === 'USD') return usdCash;
    const sr = getSimRow(ccy);
    return sr ? sr.cash : 0;
  };
  const setCash = (ccy: string, val: number) => {
    if (ccy === 'USD') { onUsdCashChange(val); return; }
    if (getSimRow(ccy)) onRowFieldChange(ccy, 'cash', val);
  };
  const getHMin = (ccy: string) => getSimRow(ccy)?.cash_floor ?? 0;
  const setHMin = (ccy: string, val: number) => {
    if (getSimRow(ccy)) onRowFieldChange(ccy, 'cash_floor', val);
  };
  const portfolioActive = activeLayers.has('portfolioDiv');
  const noLayers = !activeLayers.has('floorH') && !activeLayers.has('sigmaP') && !activeLayers.has('carryOptim') && !activeLayers.has('portfolioDiv') && !activeLayers.has('cfarCover');

  // Portfolio VAR summary panel — OVERLAY VAR (deviation of targets from the
  // hold-the-book base), matching the optimizer and the policy limit. Existing
  // LP holdings are not charged against the P&L budget.
  const portfolioResult = useMemo(() => {
    if (!portfolioActive) return null;
    const inputs: PortfolioVARInput[] = layerRows
      .filter(r => r.ccy !== 'USD')
      .map(r => ({
        ccy: r.ccy,
        cashFCY: r.usd_stress_trim ? 0 : r.cash_threshold - (r.base_hold ?? r.cash_threshold),
      }))
      .filter(inp => Math.abs(inp.cashFCY) > 0);
    return computePortfolioVAR(inputs);
  }, [layerRows, portfolioActive]);

  const th = 'px-2 py-1 text-xs font-semibold text-gray-600 text-right whitespace-nowrap align-bottom';
  const td = 'px-2 py-1.5 text-xs text-right whitespace-nowrap';

  return (
    <div className="space-y-4">

      {/* ── Controls ── */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">

          {/* Global params */}
          <div className="flex gap-5 flex-wrap">
            <NumInput label="Forecast uncertainty" value={shared.σ_P * 100} min={0} max={100} step={1} unit="%" onChange={v => onSharedChange('σ_P', v / 100)} />
            <NumInput label="USD LP credit rate" value={shared.r_USD} min={-10} max={50} step={0.05} unit="% p.a." onChange={v => onSharedChange('r_USD', v)} />
            <NumInput label="USD cash in LP" value={usdCash} min={0} max={1e9} step={10} unit="$M" onChange={onUsdCashChange} />
          </div>

          {/* Layer toggles + view toggle + calc log button */}
          <div className="flex gap-2 flex-wrap ml-auto items-center">
            {/* FCY / USD view toggle */}
            <div className="flex items-center rounded-lg border border-gray-300 bg-white overflow-hidden shadow-sm" title="Normalize position columns to USD equivalent (× spot rate) for cross-currency comparison">
              <button
                onClick={() => setViewUSD(false)}
                className={`px-3 py-2 text-xs font-semibold transition-colors ${!viewUSD ? 'bg-gray-100 text-gray-800' : 'text-gray-400 hover:text-gray-600'}`}
              >FCY</button>
              <span className="text-gray-200">|</span>
              <button
                onClick={() => setViewUSD(true)}
                className={`px-3 py-2 text-xs font-semibold transition-colors ${viewUSD ? 'bg-blue-100 text-blue-800' : 'text-gray-400 hover:text-gray-600'}`}
              >$USD</button>
            </div>
            <button
              onClick={() => setShowCalcModal(true)}
              className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-400 transition-colors shadow-sm"
              title="Show step-by-step calculation log for all active layers"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
              </svg>
              Calc Steps
            </button>
            {LAYER_DEFS.map(ld => {
              const on = ld.layers.some(id => activeLayers.has(id));
              return (
                <button
                  key={ld.id}
                  onClick={() => toggleLayerGroup(ld.layers, activeLayers, onLayerToggle)}
                  title={ld.hint}
                  className={`
                    flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-all
                    ${on
                      ? `${ld.bg} ${ld.textColor} shadow-sm`
                      : 'bg-white border-gray-200 text-gray-400 opacity-60'}
                  `}
                >
                  <span className={`inline-flex w-8 h-4 rounded-full relative ${on ? 'bg-current' : 'bg-gray-300'}`}>
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </span>
                  <span>{ld.label}</span>
                  <span className="font-mono opacity-60">{ld.formula}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Legend */}
        <div className="mt-3 flex gap-4 text-xs text-gray-500 flex-wrap">
          <span><span className="inline-block w-3 h-3 rounded bg-gray-400 mr-1 align-middle"/>Min Cash Floor</span>
          <span><span className="inline-block w-3 h-3 rounded bg-blue-500 mr-1 align-middle"/>+Safety margin</span>
          <span><span className="inline-block w-3 h-3 rounded bg-green-400 mr-1 align-middle"/>+Carry EARN (bar grows right)</span>
          <span><span className="inline-block w-3 h-3 rounded bg-red-400 mr-1 align-middle"/>−Carry PAY (bar shrinks left)</span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded bg-rose-100 border border-rose-300 align-middle"/>
            <span className="text-rose-600 font-medium">pink zone = below 0</span>
            <span className="text-gray-400">(carry exceeds safety; swap uses MAX(0,threshold))</span>
          </span>
          <span className="ml-4 text-blue-500">
            <span className="font-bold">·</span> = synced from FX Simulator
          </span>
          <span className="ml-3 text-violet-600 font-medium">
            Layer toggles also update FX Simulator buffer &amp; swap sizing
          </span>
          {portfolioActive && (
            <span className="ml-4 text-violet-600">
              <span className="inline-block w-3 h-3 rounded bg-violet-400 mr-1 align-middle"/>
              r_FCY = JPM NP credit rate (Jan 2026) · USD rate = {shared.r_USD.toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      {/* ── Per-currency table ── */}
      {/* disp(): convert M FCY → M USD when viewUSD is on; unit label updates column headers */}
      {/* Inputs stay editable in FCY; computed columns (fcast, H_final, swap) normalize to USD */}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-xs border-collapse">
          <thead>
            {/* ── Group header row ── */}
            <tr className="border-b border-gray-100">
              <th className="sticky left-0 z-20 bg-gray-100 px-2 py-1 text-left text-xs font-bold text-gray-700 align-middle" rowSpan={2}>
                CCY
              </th>
              <th className="bg-gray-50 border-l border-gray-200 px-2 py-1 text-center text-xs font-semibold text-gray-600 tracking-wide" colSpan={3}>
                POSITION INPUTS
                <span className="ml-1 font-normal text-gray-400">— editable</span>
              </th>
              <th className="bg-sky-50 border-l border-sky-200 px-2 py-1 text-center text-xs font-semibold text-sky-700 tracking-wide" colSpan={12}>
                TARGET &amp; SWAP ACTION — P&amp;L
                <span className="ml-1 font-normal text-sky-400">LP carry vs USD {shared.r_USD.toFixed(2)}%</span>
              </th>
            </tr>

            {/* ── Column name row ── */}
            <tr className="border-b-2 border-gray-300 bg-white">
              {/* Inputs */}
              <th className={`${th} bg-gray-50 border-l border-gray-200`}>
                Min Floor<br/><span className="font-normal text-gray-400">{viewUSD ? '$M USD' : 'M FCY'}</span>
              </th>
              <th className={`${th} bg-gray-50`}>
                Net Flow 1M<br/><span className="font-normal text-gray-400">{viewUSD ? '$M USD' : 'M FCY · neg = outflow'}</span>
              </th>
              <th className={`${th} bg-gray-50`}>
                Current Cash<br/><span className="font-normal text-gray-400">{viewUSD ? '$M USD' : 'M FCY'}</span>
              </th>
              {/* Carry rates — now under TARGET & SWAP ACTION group */}
              <th className={`${th} bg-sky-50 border-l border-sky-200`}>
                LP Rate<br/><span className="font-normal text-sky-400">r_FCY · Δr vs USD</span>
              </th>
              <th className={`${th} bg-sky-50 text-center`}>
                Dir<br/><span className="font-normal text-sky-400">EARN / PAY</span>
              </th>
              {/* Target & Swap */}
              <th className={`${th} bg-sky-50`}>
                Fcast Cash<br/><span className="font-normal text-sky-400">{viewUSD ? '$M USD' : 'M FCY · cash+flow'}</span>
              </th>
              <th className={`${th} bg-amber-100 text-amber-900 font-bold`}
                title="Cash Threshold = floor + safety + carry + portfolio VAR. Hover row cells for breakdown.">
                = Threshold<br/><span className="font-normal text-amber-600">M FCY · PRE-PAYOUT</span>
              </th>
              <th className={`${th} bg-amber-100 text-amber-800 font-bold`}>
                = Threshold $USD<br/><span className="font-normal text-amber-600">× spot</span>
              </th>
              <th className={`${th} bg-sky-100 font-bold text-sky-900`}>
                Swap Near M FCY<br/><span className="font-normal text-sky-500">native near leg</span>
              </th>
              <th className={`${th} bg-sky-100 font-bold text-sky-700`}>
                Swap Near $USD<br/><span className="font-normal text-sky-500">× spot · Σ must = 0</span>
              </th>
              <th className={`${th} bg-emerald-50 border-l border-emerald-200`}>
                Post-Swap Cash<br/><span className="font-normal text-emerald-400">M FCY · fcast+swap</span>
              </th>
              <th className={`${th} bg-emerald-100 border-l border-emerald-200`}>
                Post-Swap $USD<br/><span className="font-normal text-emerald-500">× spot</span>
              </th>
              <th className={`${th} bg-sky-50 border-l border-sky-200`}>
                Carry $K/yr<br/><span className="font-normal text-sky-400">threshold × spot × Δr</span>
              </th>
              <th className={`${th} bg-amber-50 border-l border-amber-200`}
                title="Carry P&L benefit from carry optimization layer: delta_carry × spot × (r_FCY−r_USD). Positive = money saved (PAY) or earned (EARN). Zero when layer is off.">
                ΔCarry $K/yr<br/><span className="font-normal text-amber-400">carry layer Δ</span>
              </th>
              <th className={`${th} bg-violet-50 border-l border-violet-200`}
                title="Carry P&L benefit from portfolio VAR layer: delta_portfolio × spot × (r_FCY−r_USD). Shows USD P&L impact of diversification adjustment. Zero when layer is off.">
                ΔVAR $K/yr<br/><span className="font-normal text-violet-400">VAR layer Δ</span>
              </th>
            </tr>
          </thead>

          <tbody>
            {layerRows.map(r => {
              if (!r) return null;
              // Carry on optimized target H_final: M FCY × USD/FCY × (r_FCY−r_USD)% / 100 × 1000 = $K/yr
              // H_final changes with every layer toggle → carry recalculates immediately.
              // (No layers: H_final = peak_cash, consistent with baseline.)
              const carry_pos = noLayers ? r.peak_cash : r.cash_threshold;
              const carry_k_pa = carry_pos * r.spot * (r.r_FCY - shared.r_USD) / 100 * 1000;
              // Per-layer carry P&L benefit: delta × spot × (r_FCY−r_USD) / 100 × 1000
              // Positive = benefit (saves PAY cost or earns EARN income). Zero when layer off.
              const delta_r_pct = r.r_FCY - shared.r_USD;
              const carry_delta_k = r.delta_carry * r.spot * delta_r_pct / 100 * 1000;
              const var_delta_k   = r.delta_portfolio * r.spot * delta_r_pct / 100 * 1000;
              const swapUSD = r.swap_needed * r.spot;
              // View normalization: multiply FCY positions by spot when USD view is active
              const disp = (fcy: number) => viewUSD ? fcy * r.spot : fcy;
              const unit = viewUSD ? '$M' : 'M';
              const deltaR = r.r_FCY - shared.r_USD;
              const threshold_minus_precash = r.cash_threshold - r.total_cash;
              return (
                <tr key={r.ccy} className="border-b border-gray-100 hover:bg-gray-50">
                  {/* CCY */}
                  <td className="sticky left-0 z-10 bg-white px-2 py-1.5 text-xs font-bold text-gray-900">
                    {r.ccy}
                    {simRows.find(s => s.ccy === r.ccy) && (
                      <span className="ml-1 text-blue-400" title="Synced from FX Simulator">·</span>
                    )}
                  </td>
                  {/* H_min per-currency floor — input always in M FCY; USD equiv. shown in tooltip */}
                  <td className="px-1 py-1 text-right bg-gray-50 border-l border-gray-200"
                    title={viewUSD ? `${fM(r.h_min)} M FCY = ${fM(r.h_min * r.spot)} $M USD (spot ${r.spot.toFixed(4)})` : undefined}
                  >
                    {viewUSD
                      ? <span className="text-xs font-mono text-gray-600">{fM(r.h_min * r.spot)}</span>
                      : <input
                          type="text" inputMode="decimal"
                          value={cellDrafts[`${r.ccy}.h_min`] ?? String(r.h_min)}
                          onChange={e => {
                            const raw = e.target.value;
                            setCellDrafts(prev => ({ ...prev, [`${r.ccy}.h_min`]: raw }));
                            const v = parseFloat(raw);
                            if (!isNaN(v)) setHMin(r.ccy, v);
                          }}
                          onBlur={() => setCellDrafts(prev => {
                            const next = { ...prev }; delete next[`${r.ccy}.h_min`]; return next;
                          })}
                          className={`w-14 text-right text-xs border rounded px-1 py-0.5 focus:outline-none
                            ${activeLayers.has('floorH') ? 'border-emerald-300 text-emerald-700 focus:border-emerald-500' : 'border-gray-200 text-gray-400 focus:border-gray-400'}`}
                        />
                    }
                  </td>
                  {/* Net Flow 1M — input always in M FCY; USD equiv. shown in tooltip */}
                  <td className="px-1 py-1 text-right bg-gray-50"
                    title={viewUSD ? `${fM(r.payout)} M FCY = ${fM(r.payout * r.spot)} $M USD (spot ${r.spot.toFixed(4)})` : undefined}
                  >
                    {viewUSD
                      ? <span className={`text-xs font-mono ${r.payout < 0 ? 'text-red-700' : 'text-green-700'}`}>{fM(r.payout * r.spot)}</span>
                      : <input
                          type="text" inputMode="decimal"
                          value={cellDrafts[`${r.ccy}.payout`] ?? String(r.payout)}
                          onChange={e => {
                            const raw = e.target.value;
                            setCellDrafts(prev => ({ ...prev, [`${r.ccy}.payout`]: raw }));
                            const v = parseFloat(raw);
                            if (!isNaN(v)) setPayout(r.ccy, v);
                          }}
                          onBlur={() => setCellDrafts(prev => {
                            const next = { ...prev }; delete next[`${r.ccy}.payout`]; return next;
                          })}
                          className={`w-16 text-right text-xs border rounded px-1 py-0.5 focus:outline-none
                            ${r.payout < 0 ? 'border-red-200 text-red-700 focus:border-red-400' : 'border-green-200 text-green-700 focus:border-green-400'}`}
                        />
                    }
                  </td>
                  {/* Current Cash — input always in M FCY; USD equiv. shown in tooltip */}
                  <td className="px-1 py-1 text-right bg-gray-50"
                    title={viewUSD ? `${fM(r.cash)} M FCY = ${fM(r.cash * r.spot)} $M USD (spot ${r.spot.toFixed(4)})` : undefined}
                  >
                    {viewUSD
                      ? <span className={`text-xs font-mono ${r.cash < 0 ? 'text-red-600' : 'text-gray-700'}`}>{fM(r.cash * r.spot)}</span>
                      : <input
                          type="text" inputMode="decimal"
                          value={cellDrafts[`${r.ccy}.cash`] ?? String(r.cash)}
                          onChange={e => {
                            const raw = e.target.value;
                            setCellDrafts(prev => ({ ...prev, [`${r.ccy}.cash`]: raw }));
                            const v = parseFloat(raw);
                            if (!isNaN(v)) setCash(r.ccy, v);
                          }}
                          onBlur={() => setCellDrafts(prev => {
                            const next = { ...prev }; delete next[`${r.ccy}.cash`]; return next;
                          })}
                          className="w-16 text-right text-xs border border-gray-200 rounded px-1 py-0.5 focus:border-blue-400 focus:outline-none"
                        />
                    }
                  </td>
                  {/* LP Rate + Δr differential — single line */}
                  <td className={`${td} bg-sky-50 border-l border-sky-200 whitespace-nowrap`}
                    title={`r_FCY = ${r.r_FCY.toFixed(3)}% | r_USD = ${shared.r_USD.toFixed(2)}% | Δr = r_FCY − r_USD = ${deltaR.toFixed(3)}% (${deltaR < -0.05 ? 'EARN: hold more FCY' : deltaR > 0.05 ? 'PAY: reduce FCY holding' : 'neutral'})`}
                  >
                    <span className="text-gray-700 font-mono">{r.r_FCY.toFixed(2)}%</span>
                    <span className={`ml-1 font-mono ${deltaR < -0.05 ? 'text-lime-600' : deltaR > 0.05 ? 'text-red-500' : 'text-gray-400'}`}>
                      Δ{deltaR >= 0 ? '+' : ''}{deltaR.toFixed(2)}%
                    </span>
                  </td>
                  {/* EARN/PAY badge */}
                  <td className={`${td} text-center`}><CarryBadge dir={r.carry_dir} /></td>
                  {/* Trough Cash = current + payout (before collections) */}
                  <td className={`${td} bg-sky-50 border-l border-sky-200 font-mono ${r.peak_cash < 0 ? 'text-red-600' : 'text-sky-700'}`}
                    title={`Trough cash = current(${f2(r.cash)}) + payout(${f2(r.payout)}) = ${f2(r.peak_cash)} M FCY (peak intra-cycle gap)${viewUSD ? ` = ${fM(r.peak_cash * r.spot)} $M USD (× spot ${r.spot.toFixed(4)})` : ''}`}
                  >
                    {fM(disp(r.peak_cash))}
                  </td>
                  {/* = Threshold (H_final) */}
                  <td className={`${td} font-bold font-mono ${
                    noLayers
                      ? 'bg-gray-100 text-gray-400 italic'
                      : r.floor_binding ? 'bg-amber-100 text-emerald-700'
                      : r.cash_threshold < -0.001 ? 'bg-amber-100 text-red-600'
                      : 'bg-amber-100 text-amber-900'
                  }`}
                    title={noLayers
                      ? `No layers active.`
                      : `P(${f2(Math.abs(r.payout))}) + floor(${f2(r.floor_contrib)}) + safety(${f2(r.delta_sigma)}) + carry(${f2(r.delta_carry)}) + portfolio(${f2(r.delta_portfolio)}) = ${f2(r.cash_threshold)} M FCY = ${fM(r.cash_threshold * r.spot)} $M USD (PRE-PAYOUT target)${r.delta_cfar > 0.001 ? ` · CFaR ${f2(r.delta_cfar)} FCY (FX P&L, not in H*)` : ''}${r.floor_binding ? ' ⌊carry < 0⌋' : ''}${(r as { usd_stress_trim?: boolean }).usd_stress_trim ? ` — USD stress trim from ${f2((r as { stress_trim_from?: number }).stress_trim_from ?? r.cash_threshold)}` : ''}`}
                  >
                    {noLayers ? '—' : fM(r.cash_threshold)}
                    {!noLayers && (r as { usd_stress_trim?: boolean }).usd_stress_trim && (
                      <span className="ml-1 text-xs font-normal text-orange-600" title="Portfolio target trimmed for USD liquidity">↘</span>
                    )}
                    {!noLayers && r.floor_binding && (
                      <span className="ml-1 text-xs font-normal text-emerald-500">⌊</span>
                    )}
                  </td>
                  <td className={`${td} font-bold font-mono bg-amber-100 ${
                    noLayers ? 'text-gray-300'
                    : r.cash_threshold < -0.001 ? 'text-red-600'
                    : 'text-amber-800'
                  }`}
                    title={`${f2(r.cash_threshold)} M FCY × spot ${r.spot.toFixed(4)}`}
                  >
                    {noLayers ? '—' : `$${fM(r.cash_threshold * r.spot)}`}
                  </td>
                  {/* Swap Near — primary unit toggles with viewUSD */}
                  <td className={`${td} bg-sky-100 font-bold font-mono ${
                    Math.abs(r.swap_needed) < 0.005 ? 'text-gray-300'
                    : r.swap_needed > 0 ? 'text-sky-800'
                    : 'text-amber-700'
                  }`}
                    title={noLayers
                      ? `Spot restructuring: −spot(${f2(r.spot_raw)}) = ${f2(-r.spot_raw)} M FCY = ${fM(-r.spot_raw * r.spot)} $M USD. Converts spot position to forward; fwd(${f2(r.fwd_raw)} $M USD = ${fM(usdToFcyM(r.fwd_raw, r.ccy))} M FCY) already at far tenor.`
                      : `H*(${f2(r.cash_threshold)}) − pre-payout cash(${f2(r.total_cash)}) = ${f2(threshold_minus_precash)} M FCY = ${fM(swapUSD)} $M USD`}
                  >
                    {Math.abs(r.swap_needed) < 0.005 ? '—' : `${r.swap_needed >= 0 ? '+' : ''}${fM(r.swap_needed)}`}
                  </td>
                  {/* Swap $USD — always shown for zero-sum validation */}
                  <td className={`${td} bg-sky-100 font-bold font-mono ${
                    Math.abs(swapUSD) < 0.005 ? 'text-gray-300'
                    : swapUSD > 0 ? 'text-sky-600'
                    : 'text-amber-500'
                  }`}
                    title={r.ccy === 'USD'
                      ? `USD funding leg = −Σ(FCY swap × spot) = ${swapUSD >= 0 ? '+' : ''}$${fM(swapUSD)}M`
                      : `Swap(${fM(r.swap_needed)}) M FCY × spot(${r.spot.toFixed(4)}) = ${swapUSD >= 0 ? '+' : ''}$${fM(swapUSD)}M USD`}
                  >
                    {Math.abs(swapUSD) < 0.005 ? '—' : `${swapUSD >= 0 ? '+' : ''}$${fM(swapUSD)}`}
                  </td>
                  {/* Post-Swap Cash = forecasted_cash + swap_needed */}
                  <td className={`${td} bg-emerald-50 border-l border-emerald-200 font-mono font-semibold ${
                    r.post_swap_cash < -0.001 ? 'text-red-600'
                    : r.post_swap_cash < 0.001 ? 'text-gray-400'
                    : 'text-emerald-700'
                  }`}
                    title={`Post-swap cash = trough(${f2(r.peak_cash)}) + swap(${f2(r.swap_needed)}) = ${f2(r.post_swap_cash)} M FCY = ${fM(r.post_swap_cash * r.spot)} $M USD. Residual after payouts = H*(${f2(r.cash_threshold)}) − P(${f2(Math.abs(r.payout))}) = ${f2(r.cash_threshold - Math.abs(r.payout))}.`}
                  >
                    {fM(r.post_swap_cash)}
                  </td>
                  <td className={`${td} bg-emerald-100 font-mono font-semibold ${
                    r.post_swap_cash < -0.001 ? 'text-red-600'
                    : r.post_swap_cash < 0.001 ? 'text-gray-400'
                    : 'text-emerald-700'
                  }`}
                    title={`${f2(r.post_swap_cash)} M FCY × spot ${r.spot.toFixed(4)}`}
                  >
                    ${fM(r.post_swap_cash * r.spot)}
                  </td>
                  {/* Carry $K/yr — on H_final (optimized target), always USD */}
                  <td className={`${td} bg-sky-50 border-l border-sky-200 font-mono font-semibold ${
                    carry_k_pa > 0.05 ? 'text-lime-700'
                    : carry_k_pa < -0.05 ? 'text-red-600'
                    : 'text-gray-300'
                  }`}
                    title={`H_final(${fM(carry_pos)} M FCY) × spot(${r.spot.toFixed(4)}) × Δr(r_FCY ${r.r_FCY.toFixed(2)}% − r_USD ${shared.r_USD.toFixed(2)}% = ${deltaR.toFixed(2)}%) / 100 × 1000 = $${carry_k_pa.toFixed(1)}K/yr`}
                  >
                    {Math.abs(carry_k_pa) < 0.05 ? '—' : `${carry_k_pa > 0 ? '+' : ''}$${carry_k_pa.toFixed(1)}K`}
                  </td>
                  {/* ΔCarry $K/yr — carry optimization layer P&L contribution */}
                  <td className={`${td} bg-amber-50 border-l border-amber-200 font-mono ${
                    activeLayers.has('carryOptim')
                      ? carry_delta_k > 0.05 ? 'text-lime-700 font-semibold'
                        : carry_delta_k < -0.05 ? 'text-red-600 font-semibold'
                        : 'text-gray-300'
                      : 'text-gray-200'
                  }`}
                    title={activeLayers.has('carryOptim')
                      ? `Carry layer benefit: delta_carry(${fM(r.delta_carry)} M FCY) × spot(${r.spot.toFixed(4)}) × Δr(${deltaR.toFixed(2)}%) / 100 × 1000 = $${carry_delta_k.toFixed(1)}K/yr. ${carry_delta_k > 0 ? 'Positive = saves PAY cost or earns EARN income.' : 'Negative = carry adjustment reduces income.'}`
                      : 'Carry Optimization layer is off — enable to see benefit'}
                  >
                    {!activeLayers.has('carryOptim') ? '—'
                      : Math.abs(carry_delta_k) < 0.05 ? '—'
                      : `${carry_delta_k > 0 ? '+' : ''}$${carry_delta_k.toFixed(1)}K`}
                  </td>
                  {/* ΔVAR $K/yr — portfolio VAR layer carry P&L contribution */}
                  <td className={`${td} bg-violet-50 border-l border-violet-200 font-mono ${
                    activeLayers.has('portfolioDiv')
                      ? var_delta_k > 0.05 ? 'text-lime-700 font-semibold'
                        : var_delta_k < -0.05 ? 'text-red-600 font-semibold'
                        : 'text-gray-300'
                      : 'text-gray-200'
                  }`}
                    title={activeLayers.has('portfolioDiv')
                      ? `VAR layer benefit: delta_portfolio(${fM(r.delta_portfolio)} M FCY) × spot(${r.spot.toFixed(4)}) × Δr(${deltaR.toFixed(2)}%) / 100 × 1000 = $${var_delta_k.toFixed(1)}K/yr. Overlay scaled uniformly to fill the portfolio VAR budget.`
                      : 'Portfolio VAR layer is off — enable to see diversification P&L impact'}
                  >
                    {!activeLayers.has('portfolioDiv') ? '—'
                      : Math.abs(var_delta_k) < 0.05 ? '—'
                      : `${var_delta_k > 0 ? '+' : ''}$${var_delta_k.toFixed(1)}K`}
                  </td>
                </tr>
              );
            })}
          </tbody>

          {/* ── Footer: totals row ── */}
          {(() => {
            const total_carry_k_pa = layerRows.reduce((s, r) => {
              const pos = noLayers ? r.forecasted_cash : r.cash_threshold;
              return s + pos * r.spot * (r.r_FCY - shared.r_USD) / 100 * 1000;
            }, 0);
            const total_carry_delta_k = activeLayers.has('carryOptim')
              ? layerRows.reduce((s, r) => s + r.delta_carry * r.spot * (r.r_FCY - shared.r_USD) / 100 * 1000, 0) : 0;
            const total_var_delta_k = activeLayers.has('portfolioDiv')
              ? layerRows.reduce((s, r) => s + r.delta_portfolio * r.spot * (r.r_FCY - shared.r_USD) / 100 * 1000, 0) : 0;
            const total_fcast_usd = layerRows.reduce((s, r) => s + r.forecasted_cash * r.spot, 0);
            const total_h_usd = layerRows.reduce((s, r) => s + (noLayers ? 0 : r.cash_threshold) * r.spot, 0);
            const total_swap_usd = (() => {
              const fcy = sumFcySwapNearUsd(layerRows.map(r => ({ ccy: r.ccy, swapNear: r.swap_needed })));
              const usdRow = layerRows.find(r => r.ccy === 'USD');
              return fcy + (usdRow?.swap_needed ?? 0);
            })();
            const total_post_swap_usd = layerRows.reduce((s, r) => s + r.post_swap_cash * r.spot, 0);
            return (
              <tfoot>
                <tr className="border-t-2 border-sky-200 bg-sky-50">
                  <td className="sticky left-0 z-10 px-2 py-1.5 text-xs font-bold text-sky-800 bg-sky-50 whitespace-nowrap">
                    TOTAL
                  </td>
                  {/* spacer cols for inputs + carry cols */}
                  <td colSpan={3} className="bg-sky-50 px-2 py-1.5"/>
                  {/* LP Rate + Δr: show weighted avg carry differential */}
                  <td colSpan={2} className="bg-sky-50 text-xs text-sky-500 italic px-2 py-1.5 text-right">
                    {`${layerRows.length} CCY · annual`}
                  </td>
                  {/* Fcast Cash total in USD */}
                  <td className={`px-2 py-1.5 text-right font-mono text-xs font-bold bg-sky-50 border-l border-sky-200 ${total_fcast_usd < 0 ? 'text-red-600' : 'text-sky-700'}`}
                    title={`Total forecasted cash position in USD: ${fM(total_fcast_usd)} $M`}>
                    {fM(viewUSD ? total_fcast_usd : total_fcast_usd)}
                    <span className="text-sky-400 font-normal ml-0.5">$M</span>
                  </td>
                  {/* H_final total */}
                  <td className={`px-2 py-1.5 text-right font-mono text-xs text-gray-400 bg-amber-50 ${noLayers ? 'text-gray-300' : ''}`}
                    title="M FCY thresholds are not additive across currencies">
                    —
                  </td>
                  <td className={`px-2 py-1.5 text-right font-mono text-xs font-bold bg-amber-100 ${noLayers ? 'text-gray-300' : total_h_usd < 0 ? 'text-red-600' : 'text-amber-800'}`}
                    title={noLayers ? 'No layers active' : `Sum of all H_final thresholds in USD: ${fM(total_h_usd)} $M`}>
                    {noLayers ? '—' : <>{fM(total_h_usd)}<span className="text-amber-500 font-normal ml-0.5">$M</span></>}
                  </td>
                  {/* Swap total — FCY col not additive */}
                  <td className="px-2 py-1.5 text-right font-mono text-xs text-gray-400 bg-sky-100"
                    title="M FCY swap legs are not additive across currencies">
                    —
                  </td>
                  <td className={`px-2 py-1.5 text-right font-mono text-xs font-bold border ${
                    Math.abs(total_swap_usd) < 0.005
                      ? 'bg-green-50 border-green-300 text-green-800'
                      : 'bg-red-50 border-red-300 text-red-700'
                  }`}
                    title={`Σ (swap × spot) across all CCY — must equal 0. Current: ${total_swap_usd >= 0 ? '+' : ''}${fM(total_swap_usd)} $M`}>
                    {Math.abs(total_swap_usd) < 0.005
                      ? <><span className="mr-0.5">✓</span>$0.00<span className="font-normal ml-1">zero-sum</span></>
                      : <><span className="mr-0.5">⚠</span>{total_swap_usd >= 0 ? '+' : ''}{fM(total_swap_usd)}<span className="font-normal ml-0.5">$M</span></>}
                  </td>
                  {/* Post-Swap Cash totals */}
                  <td className="px-2 py-1.5 text-right font-mono text-xs text-gray-400 bg-emerald-50 border-l border-emerald-200"
                    title="M FCY post-swap cash is not additive across currencies">
                    —
                  </td>
                  <td className={`px-2 py-1.5 text-right font-mono text-xs font-bold bg-emerald-100 ${total_post_swap_usd < 0 ? 'text-red-600' : 'text-emerald-700'}`}
                    title={`Total post-swap cash in USD: ${fM(total_post_swap_usd)} $M`}>
                    {fM(total_post_swap_usd)}<span className="font-normal ml-0.5">$M</span>
                  </td>
                  {/* Carry total — on H_final */}
                  <td className={`px-2 py-1.5 text-right font-mono text-xs font-bold bg-sky-50 border-l border-sky-200 ${
                    total_carry_k_pa > 0.05 ? 'text-lime-700'
                    : total_carry_k_pa < -0.05 ? 'text-red-600'
                    : 'text-gray-400'
                  }`} title={`Total annual carry on H_final positions (all ${layerRows.length} CCY in USD): $${total_carry_k_pa.toFixed(1)}K/yr = $${(total_carry_k_pa/1000).toFixed(3)}M/yr`}>
                    {Math.abs(total_carry_k_pa) < 0.05 ? '—' : `${total_carry_k_pa > 0 ? '+' : ''}$${(Math.abs(total_carry_k_pa) >= 1000 ? (total_carry_k_pa/1000).toFixed(1)+'M' : total_carry_k_pa.toFixed(1)+'K')}`}
                  </td>
                  {/* ΔCarry total */}
                  <td className={`px-2 py-1.5 text-right font-mono text-xs font-bold bg-amber-50 border-l border-amber-200 ${
                    !activeLayers.has('carryOptim') ? 'text-gray-300'
                    : total_carry_delta_k > 0.05 ? 'text-lime-700'
                    : total_carry_delta_k < -0.05 ? 'text-red-600'
                    : 'text-gray-400'
                  }`} title={activeLayers.has('carryOptim') ? `Total carry optimization benefit: $${total_carry_delta_k.toFixed(1)}K/yr` : 'Carry layer off'}>
                    {!activeLayers.has('carryOptim') ? '—'
                      : Math.abs(total_carry_delta_k) < 0.05 ? '—'
                      : `${total_carry_delta_k > 0 ? '+' : ''}$${(Math.abs(total_carry_delta_k) >= 1000 ? (total_carry_delta_k/1000).toFixed(1)+'M' : total_carry_delta_k.toFixed(1)+'K')}`}
                  </td>
                  {/* ΔVAR total */}
                  <td className={`px-2 py-1.5 text-right font-mono text-xs font-bold bg-violet-50 border-l border-violet-200 ${
                    !activeLayers.has('portfolioDiv') ? 'text-gray-300'
                    : total_var_delta_k > 0.05 ? 'text-lime-700'
                    : total_var_delta_k < -0.05 ? 'text-red-600'
                    : 'text-gray-400'
                  }`} title={activeLayers.has('portfolioDiv') ? `Total portfolio VAR diversification carry benefit: $${total_var_delta_k.toFixed(1)}K/yr` : 'Portfolio VAR layer off'}>
                    {!activeLayers.has('portfolioDiv') ? '—'
                      : Math.abs(total_var_delta_k) < 0.05 ? '—'
                      : `${total_var_delta_k > 0 ? '+' : ''}$${(Math.abs(total_var_delta_k) >= 1000 ? (total_var_delta_k/1000).toFixed(1)+'M' : total_var_delta_k.toFixed(1)+'K')}`}
                  </td>
                </tr>
              </tfoot>
            );
          })()}
        </table>
      </div>

      {/* USD liquidity constraint — always visible when layers active */}
      {!noLayers && (() => {
        const usdRow = layerRows.find(r => r.ccy === 'USD');
        if (!usdRow) return null;
        const reserved = usdRow.raw_sum ?? usdRow.cash_threshold;
        const fcySwapUsd = sumFcySwapNearUsd(layerRows.map(r => ({ ccy: r.ccy, swapNear: r.swap_needed })));
        const available = (usdRow as { usd_available_for_fcy?: number }).usd_available_for_fcy ?? Math.max(0, usdCash - reserved);
        const shortfall = (usdRow as { usd_fcy_shortfall?: number }).usd_fcy_shortfall ?? Math.max(0, Math.max(0, fcySwapUsd) - available);
        const binding = (usdRow as { budget_binding?: boolean }).budget_binding ?? shortfall > 0.001;
        const stressBinding = (usdRow as { usd_stress_binding?: boolean }).usd_stress_binding;
        const stressTrimmed = layerRows.filter(r => (r as { usd_stress_trim?: boolean }).usd_stress_trim);
        const payoutGap = (usdRow as { usd_payout_gap?: number }).usd_payout_gap ?? Math.max(0, reserved - usdCash);
        const liquidityMode = (usdRow as { usd_liquidity_mode?: string }).usd_liquidity_mode ?? 'normal';
        const swapBalanced = Math.abs(fcySwapUsd + (usdRow.swap_needed ?? 0)) < 0.01;
        return (
          <div className={`rounded-lg border px-4 py-3 text-xs space-y-2 ${binding ? 'bg-orange-50 border-orange-300' : 'bg-slate-50 border-slate-200'}`}>
            <div className="font-semibold text-gray-700">
              USD liquidity constraint
              <span className="font-normal text-gray-400 ml-1">— payout buffer reserved first; then FCY collateral</span>
              <span className={`ml-2 font-medium ${liquidityMode === 'stress' ? 'text-orange-700' : 'text-green-700'}`}>
                {liquidityMode === 'stress' ? 'STRESS rebalance' : 'NORMAL optimization'}
              </span>
              {swapBalanced
                ? <span className="ml-2 text-green-700 font-medium">✓ Σ swap $USD = 0</span>
                : <span className="ml-2 text-red-600 font-medium">⚠ Σ swap $USD ≠ 0</span>}
              {stressBinding && shortfall < 0.001 && (
                <span className="ml-2 text-orange-700 font-medium">↘ forced FCY rebalance</span>
              )}
            </div>
            {payoutGap > 0.001 && (
              <div className="text-red-700 font-sans font-medium">
                USD payout gap ${f2(payoutGap)}M — LP cash below payout buffer reservation
              </div>
            )}
            {stressTrimmed.length > 0 && (
              <div className="text-orange-800 font-sans">
                USD shortfall resolved by trimming portfolio targets:{' '}
                {stressTrimmed.map(r => {
                  const from = (r as { stress_trim_from?: number }).stress_trim_from;
                  return `${r.ccy} ${from !== undefined ? `${f2(from)}→` : ''}${f2(r.cash_threshold)}M`;
                }).join(', ')}
                {' '}(EARN→0; PAY with r_OD&gt;r_USD→0; PAY with r_OD≤r_USD kept)
              </div>
            )}
            {liquidityMode === 'normal' && !binding && (
              <div className="text-green-800 font-sans">
                USD sufficient — full portfolio optimization (incl. sell low-yield PAY / receive USD)
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 font-mono">
              <div><span className="text-gray-500">LP cash</span><div className="font-bold">${f2(usdCash)}M</div></div>
              <div><span className="text-gray-500">Reserved (H* USD)</span><div className="font-bold text-amber-800">${f2(reserved)}M</div><div className="text-gray-400 font-sans text-[10px]">|payout| + min floor + σ buffer</div></div>
              <div><span className="text-gray-500">Available for FCY</span><div className={`font-bold ${available < Math.max(0, fcySwapUsd) ? 'text-orange-700' : 'text-green-700'}`}>${f2(available)}M</div></div>
              <div><span className="text-gray-500">FCY swap need</span><div className="font-bold">${f2(fcySwapUsd)}M</div></div>
              <div><span className="text-gray-500">USD funding leg</span><div className="font-bold">${f2(usdRow.swap_needed)}M</div>{binding && <div className="text-red-600 font-sans font-semibold">Shortfall ${f2(shortfall)}M</div>}</div>
            </div>
          </div>
        );
      })()}

      {/* ── Portfolio summary panel (visible when portfolioDiv active) ── */}
      {portfolioActive && portfolioResult && portfolioResult.currencies.length > 0 && (
        <div className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold text-violet-800 uppercase tracking-wide">
              Portfolio USD Notional Optimization
            </span>
            <span className="text-xs text-violet-500">— 1-month 95% VAR, {portfolioResult.currencies.length} currencies</span>
            {/* Policy VAR limit selector — feeds into portfolio carry optimizer */}
            <div className="ml-auto flex flex-wrap items-end gap-2">
              <span className="text-xs text-violet-600 font-medium">Policy limit:</span>
              {POLICY_LIMITS.map(pl => (
                <button
                  key={pl.usd}
                  onClick={() => onPolicyVARChange(pl.usd)}
                  className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                    policyVAR === pl.usd
                      ? 'bg-violet-700 text-white border-violet-700'
                      : 'bg-white text-violet-600 border-violet-300 hover:bg-violet-100'
                  }`}
                  title={`Set portfolio carry optimization VAR limit to ${pl.label} (${pl.who})`}
                >
                  {pl.label}
                </button>
              ))}
              <DeskStepper
                label="Policy VAR"
                value={policyVAR}
                min={0.5}
                max={25}
                step={0.5}
                onChange={onPolicyVARChange}
                formatValue={v => `$${v.toFixed(1)}M`}
                editable
                accent="violet"
                tickValues={[0.5, 5, 10, 20, 25]}
                className="min-w-[220px] w-[240px]"
                editClassName="w-14"
                title="Drag or type any intermediate P&L limit ($0.5M–$25M, $0.5M steps)"
                ariaLabel="Policy VAR P&L limit"
              />
            </div>
          </div>
          {/* Portfolio VAR fill status row — shows when portfolio optimizer ran */}
          {activeLayers.has('carryOptim') && (() => {
            const anyVarBinding    = layerRows.some(r => (r as { var_binding?: boolean }).var_binding);
            const anyStressTrim = layerRows.some(r => (r as { usd_stress_trim?: boolean }).usd_stress_trim);
            const anyBudgetBinding = layerRows.some(r => (r as { budget_binding?: boolean }).budget_binding);
            const anyVarTrim = layerRows.some(r => (r as { var_trim?: boolean }).var_trim);
            const anyProblem = anyBudgetBinding || anyStressTrim || anyVarTrim;
            const fcyBudget = computeFcyCollateralBudget(usdCash, layerRows.find(r => r.ccy === 'USD')?.raw_sum ?? 0);
            const statusColor = anyProblem ? 'bg-amber-50 border border-amber-200' : 'bg-green-50 border border-green-200';
            return (
              <div className={`flex items-center flex-wrap gap-3 rounded px-3 py-1.5 text-xs ${statusColor}`}>
                {anyVarBinding && !anyProblem && (
                  <span className="font-medium text-green-700">
                    ✓ Carry maximized — overlay VAR (deviation from hold-the-book) fills the ${policyVAR}M P&amp;L budget
                  </span>
                )}
                {anyBudgetBinding && !anyStressTrim && (
                  <span className="font-medium text-orange-700">
                    ⚠ USD collateral budget binding
                    <span className="font-normal text-gray-500 ml-1">(net overlay USD draw capped at ${f2(fcyBudget)}M, below the VAR limit)</span>
                  </span>
                )}
                {anyVarTrim && (
                  <span className="font-medium text-amber-700">
                    ⚠ Overlay trimmed back toward hold-the-book to fit the ${policyVAR}M P&amp;L limit
                  </span>
                )}
                {anyStressTrim && (
                  <span className="font-medium text-orange-700">
                    ⚠ USD liquidity stress — portfolio VAR targets force-trimmed (EARN→0; r_OD&gt;r_USD PAY→0)
                  </span>
                )}
                {!anyVarBinding && !anyProblem && (
                  <span className="font-medium text-green-700">✓ Within limit — carry overlay fits under the VAR budget</span>
                )}
              </div>
            );
          })()}

          {/* Key metrics row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {(() => {
              const fcyBudget = computeFcyCollateralBudget(usdCash, layerRows.find(r => r.ccy === 'USD')?.raw_sum ?? 0);
              const usdCommitted = activeLayers.has('carryOptim')
                ? layerRows.reduce((sum, r) => {
                    const p = CURRENCY_PARAMS[r.ccy];
                    return sum + (p && r.cash_threshold > 0 && r.ccy !== 'USD' ? r.cash_threshold * p.spot : 0);
                  }, 0)
                : portfolioResult.total_cash_USD;
              const free = fcyBudget - usdCommitted;
              const usedPct = fcyBudget > 0 ? usdCommitted / fcyBudget * 100 : 0;
              const isHigh = usedPct > 30;
              const anyBudgetBinding = layerRows.some(r => (r as { budget_binding?: boolean }).budget_binding);
              return (
                <>
                  <div className="rounded bg-white border border-violet-100 px-3 py-2">
                    <div className="text-xs text-gray-500">USD cash in LP</div>
                    <div className="text-base font-bold text-gray-700">${f2(usdCash)}M</div>
                    <div className="text-xs text-gray-400">
                      {usdPayout < 0 ? `−$${f2(-usdPayout)}M payout → $${f2(fcyBudget)}M for FCY` : 'Budget constraint'}
                    </div>
                  </div>
                  <div className={`rounded border px-3 py-2 ${anyBudgetBinding ? 'bg-orange-50 border-orange-300' : isHigh ? 'bg-amber-50 border-amber-200' : 'bg-white border-violet-100'}`}>
                    <div className="text-xs text-gray-500">H* USD committed</div>
                    <div className={`text-base font-bold ${anyBudgetBinding ? 'text-orange-700' : isHigh ? 'text-amber-700' : 'text-gray-900'}`}>
                      ${f2(usdCommitted)}M
                    </div>
                    <div className={`text-xs ${anyBudgetBinding ? 'text-orange-500' : isHigh ? 'text-amber-500' : 'text-gray-400'}`}>
                      {usedPct.toFixed(1)}% of LP balance{anyBudgetBinding ? ' — budget binding' : ''}
                    </div>
                  </div>
                  <div className={`rounded border px-3 py-2 ${free < 0 ? 'bg-red-50 border-red-200' : free < fcyBudget * 0.2 ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'}`}>
                    <div className="text-xs text-gray-500">Free USD capacity</div>
                    <div className={`text-base font-bold ${free < 0 ? 'text-red-700' : free < fcyBudget * 0.2 ? 'text-amber-700' : 'text-green-700'}`}>
                      ${f2(free)}M
                    </div>
                    <div className="text-xs text-gray-400">{(100 - usedPct).toFixed(1)}% available</div>
                  </div>
                </>
              );
            })()}
            <div className="rounded bg-white border border-violet-100 px-3 py-2">
              <div className="text-xs text-gray-500">Standalone VAR</div>
              <div className="text-base font-bold text-orange-700">${f3(portfolioResult.standalone_sum_USD)}M</div>
              <div className="text-xs text-gray-400">No diversification</div>
            </div>
            <div className={`rounded border px-3 py-2 ${portfolioResult.portfolio_VAR_USD >= 20 ? 'bg-red-50 border-red-200' : portfolioResult.portfolio_VAR_USD >= 10 ? 'bg-orange-50 border-orange-200' : portfolioResult.portfolio_VAR_USD >= 5 ? 'bg-amber-50 border-amber-200' : 'bg-white border-violet-100'}`}>
              <div className="text-xs text-gray-500">Portfolio VAR (1M 95%)</div>
              <div className={`text-base font-bold ${portfolioResult.portfolio_VAR_USD >= 20 ? 'text-red-700' : portfolioResult.portfolio_VAR_USD >= 10 ? 'text-orange-700' : portfolioResult.portfolio_VAR_USD >= 5 ? 'text-amber-700' : 'text-green-700'}`}>
                ${f3(portfolioResult.portfolio_VAR_USD)}M
              </div>
              <div className="text-xs text-gray-400">Diversified</div>
            </div>
            <div className="rounded bg-white border border-green-200 px-3 py-2">
              <div className="text-xs text-gray-500">Diversification saving</div>
              <div className="text-base font-bold text-green-700">${f3(portfolioResult.div_benefit_USD)}M</div>
              <div className="text-xs text-green-600">Factor: {(portfolioResult.div_factor * 100).toFixed(0)}% of standalone</div>
            </div>
          </div>

          {/* Policy limits */}
          <div>
            <div className="text-xs text-gray-500 mb-1.5 font-medium">Policy VAR thresholds (FX Hedging Policy §Stressed P&L VAR Limits):</div>
            <PolicyLimitBars varUSD={portfolioResult.portfolio_VAR_USD} />
          </div>

          {/* Diversification note */}
          <div className="text-xs text-violet-700 bg-white rounded border border-violet-100 px-3 py-2 space-y-0.5">
            <p>
              <strong>Beta &lt; 0.70:</strong> Good diversifier — low correlation with portfolio, component VAR well below standalone.
              {' '}
              <strong>JPY</strong> is the strongest diversifier (negative correlation with EM).
            </p>
            <p>
              <strong>Beta &gt; 0.90:</strong> High correlation — little diversification benefit.
              EUR, SEK, NOK, PLN, HUF move together (European FX block, ρ = 0.70–0.83).
            </p>
            <p>
              <strong>Diversification factor {(portfolioResult.div_factor * 100).toFixed(0)}%</strong>
              {' '}— portfolio VAR is {(portfolioResult.div_factor * 100).toFixed(0)}% of the standalone sum.
              {portfolioResult.div_factor < 0.70
                ? ' Significant diversification benefit from non-correlated currencies.'
                : portfolioResult.div_factor < 0.85
                ? ' Moderate diversification benefit.'
                : ' Limited diversification — concentrated in correlated currency block.'}
            </p>
          </div>
        </div>
      )}


      {/* ── Logic note ── */}
      <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-xs text-gray-500 space-y-1">
        <p>
          <strong>How Cash Threshold is built:</strong>{' '}
          Floor + Safety (|P|×σ_P×z₉₅) + Carry adjustment + Portfolio VAR carry-optimized.{' '}
          <strong>Portfolio VAR layer — carry-aware combined optimization:</strong>{' '}
          standalone VAR (|payout| × σ_daily × √21 × z₉₅) defines var_FCY per currency.
          PAY carry (Δr &gt; 0): target = MIN(raw_sum, −var_FCY) — go SHORT to earn USD−FCY spread; if carryOptim went deeper, respected.
          EARN carry (Δr &lt; 0): target = +var_FCY — go LONG to earn FCY rate; always floor/cap.
          Standalone (only portfolioDiv ON): PAY carry → short at −var_FCY; EARN carry → long at +var_FCY.{' '}
          <span className="text-violet-700 font-medium">Violet +</span> = raised to +var_FCY (EARN carry or neutral floor).{' '}
          <span className="text-rose-700 font-medium">Rose −</span> = PAY carry short target applied (pushed to −var_FCY).{' '}
          <span className="text-orange-600 font-medium">Orange −</span> = EARN carry cap (raw_sum above +var_FCY).{' '}
          <span className="text-emerald-700 font-medium">⌊floor⌋</span> = carry reduced below floor contribution (layers 1-3 only).
          <span className="text-rose-600 font-medium"> Red threshold</span> = negative H_final (PAY carry — accept LP overdraft, earns carry spread).
        </p>
        <p>
          <strong>Swap Near</strong> = MAX(Cash Threshold − Forecasted Cash, −(Spot + Fwd)).{' '}
          Forecasted Cash = Current Cash + Net Flow 1M.{' '}
          Book restructuring uses the NET position (spot + forward combined), per decisions doc: I = MAX(H−(F+G), −(C+D)).{' '}
          If spot=−100 and fwd=+100, net book=0 → no book restructuring impact; swap = MAX(threshold−fcast, 0).{' '}
          Hover the swap cell to see all components.
        </p>
        <p>
          <strong>Swap Near</strong>:{' '}
          Layers OFF → Swap = −(Spot+Fwd) only: pure book restructuring of the outright FX position. Cash is irrelevant — no threshold, no buffer concept.
          Layers ON → Swap = MAX(Threshold − Fcast, −(Spot+Fwd)): cash-to-threshold maintenance combined with book restructuring.
          Near leg always = −Far leg (I + J = 0).
        </p>
        <p>
          <strong>EARN carry</strong> (LP Rate &gt; USD rate): holding more FCY is profitable — safety margin grows.{' '}
          <strong>PAY carry</strong> (LP Rate &lt; USD rate): holding FCY costs money — safety margin shrinks.
        </p>
        <p>
          <strong>LP Rate</strong> = JPM Notional Pool credit rate (Jan 2026).
          TRY LP = 1.16% (vs ~46% nominal) — most currencies pay carry vs USD LP 3.50%.
          EARN carry: GBP 3.57%, HUF 5.69%, MXN 6.19%, ZAR 6.01%.
        </p>
        {portfolioActive && (
          <p>
            <strong>Portfolio VAR — carry-aware combined optimization:</strong> var_FCY = standalone VAR (|payout|, 14×14 corr., 1M 95%) per currency.
            {' '}<strong>PAY carry (Δr &gt; 0):</strong> target = MIN(raw_sum, −var_FCY): push H to −var_FCY (go short, earn USD−FCY spread); if carryOptim already set raw_sum &lt; −var_FCY, leave it (delta=0).
            {' '}<strong>EARN carry (Δr &lt; 0):</strong> target = +var_FCY: always floor/cap to long VAR bound.
            {' '}<strong>Neutral:</strong> floor positive to +var_FCY; accept small negatives as-is.
            {' '}<span className="text-violet-700 font-medium">Violet +</span> = raised to +var_FCY (EARN/neutral floor).
            {' '}<span className="text-rose-700 font-medium">Rose −</span> = PAY carry short target applied.
            {' '}<span className="text-orange-600 font-medium">Orange −</span> = EARN carry cap.
            {' '}<strong>Annual Carry $K/yr:</strong> forecasted_cash × spot(USD/FCY) × (r_FCY−r_USD)/100 × 1000. Carry income/cost on the actual FCY position in USD-equivalent $K/yr. Always shown regardless of active layers — the position earns/costs carry whether or not any buffer layer is on. Positive = net carry income (either EARN currency long, or PAY currency in overdraft at cheap rate).
            {' '}<strong>Total Benefit $K/yr:</strong> Comp ΔVar×1000×12 + carry_optim_delta. Annualised: 1-month VAR risk reduction × 12 plus the carry benefit of the optimization delta (not raw H_final carry).
            {' '}Summary panel VAR computed from positive H_final only (long FCY buffer holdings).
          </p>
        )}
      </div>

      {/* ── Calculation Steps Modal ────────────────────────────────────────────── */}
      {showCalcModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setShowCalcModal(false)}
        >
          <div
            className="relative bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-5xl mx-4 max-h-[90vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* ── Modal header ── */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-gray-50 rounded-t-xl flex-shrink-0">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-bold text-gray-900">Calculation Log</span>
                <span className="text-xs text-gray-400">—</span>
                <div className="flex gap-1.5 flex-wrap">
                  {LAYER_DEFS.map(ld => {
                    const on = ld.layers.some(id => activeLayers.has(id));
                    return (
                    <span key={ld.id} className={`px-2 py-0.5 rounded text-xs font-medium border ${
                      on ? `${ld.bg} ${ld.textColor}` : 'bg-gray-50 text-gray-300 border-gray-200'
                    }`}>
                      {on ? '✓' : '○'} {ld.label}
                    </span>
                    );
                  })}
                </div>
                <span className="text-xs text-gray-500 ml-2">
                  Path: <span className="font-semibold">
                    {activeLayers.has('portfolioDiv') && activeLayers.has('carryOptim')
                      ? 'A — VAR-budget fill'
                      : activeLayers.has('carryOptim')
                      ? 'C — Per-currency carry'
                      : activeLayers.has('portfolioDiv')
                      ? 'B — Portfolio heuristic'
                      : 'No layers'}
                  </span>
                </span>
              </div>
              <button
                onClick={() => setShowCalcModal(false)}
                className="ml-4 text-gray-400 hover:text-gray-700 text-xl font-bold leading-none flex-shrink-0"
              >
                ×
              </button>
            </div>

            {/* ── Scrollable body ── */}
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-6 text-xs">

              {/* Global params */}
              <section>
                <div className="text-xs font-bold text-gray-600 uppercase tracking-wide mb-2">Global Parameters</div>
                <div className="flex gap-5 flex-wrap bg-gray-50 rounded border border-gray-200 px-3 py-2">
                  <span>σ_P = <strong>{(shared.σ_P * 100).toFixed(0)}%</strong> <span className="text-gray-400">(forecast uncertainty)</span></span>
                  <span>r_USD = <strong>{shared.r_USD.toFixed(2)}%</strong> <span className="text-gray-400">(USD LP credit rate)</span></span>
                  {activeLayers.has('portfolioDiv') && activeLayers.has('carryOptim') && (
                    <span>Policy VAR limit = <strong className="text-violet-700">${policyVAR}M</strong></span>
                  )}
                  <span className="text-gray-400">z₉₅ = 1.645</span>
                </div>
              </section>

              {/* ── PASS 1 ── */}
              <section>
                <div className="text-xs font-bold text-blue-700 uppercase tracking-wide mb-1">
                  Pass 1 — Floor + Safety
                </div>
                <div className="text-xs text-gray-500 mb-2">
                  <code className="bg-gray-100 rounded px-1 py-0.5">H_base = H_min</code> if floorH on, else 0 ·{' '}
                  <code className="bg-gray-100 rounded px-1 py-0.5">δ_σ = |P| × σ_P × z₉₅</code> ·{' '}
                  <code className="bg-gray-100 rounded px-1 py-0.5">raw_sum = H_base + δ_σ</code>{' '}
                  (carry excluded here when Path A is active)
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                        <th className="px-2 py-1.5 text-left font-semibold">CCY</th>
                        <th className="px-2 py-1.5 text-right font-semibold">|Payout| M</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Cash M</th>
                        <th className="px-2 py-1.5 text-right font-semibold">r_FCY %</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Δr</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Direction</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-emerald-700">H_base</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-blue-700">δ_σ</th>
                        <th className="px-2 py-1.5 text-right font-semibold">raw_sum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {layerRows.map(r => (
                        <tr key={r.ccy} className="border-b border-gray-100 hover:bg-blue-50">
                          <td className="px-2 py-1 font-bold text-gray-800">{r.ccy}</td>
                          <td className="px-2 py-1 text-right font-mono">{Math.abs(r.payout).toFixed(2)}</td>
                          <td className="px-2 py-1 text-right font-mono text-sky-700">{r.cash.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right font-mono">{r.r_FCY.toFixed(2)}</td>
                          <td className={`px-2 py-1 text-right font-mono ${r.delta_r > 0.05 ? 'text-red-600' : r.delta_r < -0.05 ? 'text-green-600' : 'text-gray-400'}`}>
                            {r.delta_r > 0 ? '+' : ''}{r.delta_r.toFixed(2)}%
                          </td>
                          <td className={`px-2 py-1 text-right font-medium ${
                            r.carry_dir === 'earn' ? 'text-green-700 bg-green-50'
                            : r.carry_dir === 'pay' ? 'text-red-700 bg-red-50'
                            : 'text-gray-400'
                          } rounded`}>
                            {r.carry_dir.toUpperCase()}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-emerald-700">{r.floor_contrib.toFixed(3)}</td>
                          <td className="px-2 py-1 text-right font-mono text-blue-700">+{r.delta_sigma.toFixed(3)}</td>
                          <td className="px-2 py-1 text-right font-mono font-semibold text-gray-800">
                            {(r.floor_contrib + r.delta_sigma).toFixed(3)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* ── PASS 2 — Carry ── */}
              {(activeLayers.has('carryOptim') || activeLayers.has('portfolioDiv')) && (
                <section>
                  <div className="text-xs font-bold text-amber-700 uppercase tracking-wide mb-1">
                    Pass 2 — Carry Optimization
                  </div>
                  <div className="text-xs text-gray-500 mb-2">
                    {activeLayers.has('portfolioDiv') && activeLayers.has('carryOptim') ? (
                      <>
                        <strong className="text-amber-700">Path A — overlay-VAR budget fill:</strong>{' '}
                        Policy VAR is charged on the carry OVERLAY (deviation from hold-the-book LP),
                        not on existing holdings. One factor s scales the full carry leg of every
                        currency so Overlay_VAR = ${policyVAR}M. s = 1 ≡ the per-currency carry stack;
                        tight limit → s &lt; 1 (shrink toward hold), loose limit → s &gt; 1 (amplify carry),
                        until the USD collateral budget binds.
                      </>
                    ) : activeLayers.has('carryOptim') ? (
                      <>
                        <strong className="text-amber-700">Path C — Per-currency:</strong>{' '}
                        <code className="bg-gray-100 rounded px-1 py-0.5">z_opt = Φ⁻¹(1 − Δr/r_OD)</code> ·{' '}
                        <code className="bg-gray-100 rounded px-1 py-0.5">δ_carry = P × σ_P × (z_opt − z₉₅)</code>.
                        No portfolio constraint.
                      </>
                    ) : (
                      <>
                        <strong className="text-amber-700">Path B — Portfolio heuristic:</strong>{' '}
                        Push each currency toward ±var_FCY in carry-optimal direction. No analytical optimum.
                      </>
                    )}
                  </div>

                  {/* Path A: VAR-budget fill banner */}
                  {activeLayers.has('portfolioDiv') && activeLayers.has('carryOptim') && (() => {
                    const budgetBinding = layerRows.some(r => r.budget_binding);
                    const varTrim = layerRows.some(r => r.var_trim);
                    const varFilled = layerRows.some(r => r.var_binding);
                    if (budgetBinding) {
                      return (
                        <div className="rounded px-3 py-2 mb-3 border text-xs bg-orange-50 border-orange-200">
                          <span className="font-semibold text-orange-800">⚠ USD collateral budget binding</span>
                          <span className="text-orange-700 ml-2">
                            EARN buys exceed available USD — carry capped below the ${policyVAR}M VAR limit.
                          </span>
                        </div>
                      );
                    }
                    if (varTrim) {
                      return (
                        <div className="rounded px-3 py-2 mb-3 border text-xs bg-amber-50 border-amber-200">
                          <span className="font-semibold text-amber-800">⚠ Base cushions exceed limit</span>
                          <span className="text-amber-700 ml-2">
                            Liquidity buffers alone breach ${policyVAR}M — targets trimmed toward the hard floor.
                          </span>
                        </div>
                      );
                    }
                    return (
                      <div className="rounded px-3 py-2 mb-3 border text-xs bg-green-50 border-green-200">
                        <span className="font-semibold text-green-800">
                          {varFilled ? '✓ Carry maximized — VAR filled to limit' : '✓ Within limit'}
                        </span>
                        <span className="text-green-700 ml-2">
                          Overlay scaled uniformly so Portfolio VAR = ${policyVAR}M · raise the limit for bigger positions.
                        </span>
                      </div>
                    );
                  })()}

                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                          <th className="px-2 py-1.5 text-left font-semibold">CCY</th>
                          <th className="px-2 py-1.5 text-right font-semibold">Δr</th>
                          <th className="px-2 py-1.5 text-right font-semibold">Direction</th>
                          <th className="px-2 py-1.5 text-right font-semibold">z_opt</th>
                          <th className="px-2 py-1.5 text-right font-semibold text-amber-700">δ_carry M</th>
                          <th className="px-2 py-1.5 text-right font-semibold text-violet-700">δ_portfolio M</th>
                          <th className="px-2 py-1.5 text-right font-semibold">raw_sum + carry</th>
                          {activeLayers.has('portfolioDiv') && activeLayers.has('carryOptim') && (
                            <th className="px-2 py-1.5 text-right font-semibold text-amber-600">Constrained?</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {layerRows.map(r => (
                          <tr key={r.ccy} className={`border-b border-gray-100 hover:bg-amber-50 ${r.constrained ? 'bg-amber-50' : ''}`}>
                            <td className="px-2 py-1 font-bold text-gray-800">{r.ccy}</td>
                            <td className={`px-2 py-1 text-right font-mono ${r.delta_r > 0.05 ? 'text-red-600' : r.delta_r < -0.05 ? 'text-green-600' : 'text-gray-400'}`}>
                              {r.delta_r > 0 ? '+' : ''}{r.delta_r.toFixed(2)}%
                            </td>
                            <td className={`px-2 py-1 text-right font-medium text-xs ${
                              r.carry_dir === 'earn' ? 'text-green-700' : r.carry_dir === 'pay' ? 'text-red-700' : 'text-gray-400'
                            }`}>
                              {r.carry_dir.toUpperCase()}
                            </td>
                            <td className="px-2 py-1 text-right font-mono">{r.z_opt.toFixed(3)}</td>
                            <td className={`px-2 py-1 text-right font-mono ${r.delta_carry > 0.001 ? 'text-green-700' : r.delta_carry < -0.001 ? 'text-red-700' : 'text-gray-400'}`}>
                              {Math.abs(r.delta_carry) > 0.001
                                ? `${r.delta_carry >= 0 ? '+' : ''}${r.delta_carry.toFixed(3)}`
                                : '—'}
                            </td>
                            <td className={`px-2 py-1 text-right font-mono ${Math.abs(r.delta_portfolio) > 0.001 ? 'text-violet-700' : 'text-gray-300'}`}>
                              {Math.abs(r.delta_portfolio) > 0.001
                                ? `${r.delta_portfolio >= 0 ? '+' : ''}${r.delta_portfolio.toFixed(3)}`
                                : '—'}
                            </td>
                            <td className="px-2 py-1 text-right font-mono font-semibold text-gray-800">
                              {(r.floor_contrib + r.delta_sigma + r.delta_carry).toFixed(3)}
                            </td>
                            {activeLayers.has('portfolioDiv') && activeLayers.has('carryOptim') && (
                              <td className={`px-2 py-1 text-right font-semibold ${r.constrained ? 'text-amber-700' : 'text-green-600'}`}>
                                {r.constrained ? '⚠ yes' : '✓ no'}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* ── PASS 3 — Final ── */}
              <section>
                <div className="text-xs font-bold text-sky-700 uppercase tracking-wide mb-1">
                  Pass 3 — Final Thresholds &amp; Swap Inputs
                </div>
                <div className="text-xs text-gray-500 mb-2">
                  <code className="bg-gray-100 rounded px-1 py-0.5">H_final = raw_sum + δ_portfolio</code> ·{' '}
                  <code className="bg-gray-100 rounded px-1 py-0.5">FC = Cash + Payout</code> ·{' '}
                  <code className="bg-gray-100 rounded px-1 py-0.5">Swap = MAX(H_final − FC, −(Spot+Fwd))</code>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                        <th className="px-2 py-1.5 text-left font-semibold">CCY</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-emerald-700">H_base</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-blue-700">+δ_σ</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-amber-700">+δ_carry</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-violet-700">+δ_portf</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-gray-900">= H_final</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-sky-700">FC M</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-gray-600">−(Spot+Fwd)</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-sky-800">Swap Near M</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-gray-500">Far Leg</th>
                      </tr>
                    </thead>
                    <tbody>
                      {layerRows.map(r => {
                        const swapColor = r.swap_needed > 0.005
                          ? 'text-blue-700 font-bold'
                          : r.swap_needed < -0.005
                          ? 'text-red-700 font-bold'
                          : 'text-gray-400';
                        const hColor = r.cash_threshold < -0.001 ? 'text-red-700' : 'text-gray-900';
                        return (
                          <tr key={r.ccy} className="border-b border-gray-100 hover:bg-sky-50">
                            <td className="px-2 py-1 font-bold text-gray-800">{r.ccy}</td>
                            <td className="px-2 py-1 text-right font-mono text-emerald-700">{r.floor_contrib.toFixed(3)}</td>
                            <td className="px-2 py-1 text-right font-mono text-blue-700">
                              {r.delta_sigma > 0.001 ? `+${r.delta_sigma.toFixed(3)}` : '—'}
                            </td>
                            <td className={`px-2 py-1 text-right font-mono ${r.delta_carry > 0.001 ? 'text-green-700' : r.delta_carry < -0.001 ? 'text-red-700' : 'text-gray-300'}`}>
                              {Math.abs(r.delta_carry) > 0.001
                                ? `${r.delta_carry >= 0 ? '+' : ''}${r.delta_carry.toFixed(3)}`
                                : '—'}
                            </td>
                            <td className={`px-2 py-1 text-right font-mono ${Math.abs(r.delta_portfolio) > 0.001 ? 'text-violet-700' : 'text-gray-300'}`}>
                              {Math.abs(r.delta_portfolio) > 0.001
                                ? `${r.delta_portfolio >= 0 ? '+' : ''}${r.delta_portfolio.toFixed(3)}`
                                : '—'}
                            </td>
                            <td className={`px-2 py-1 text-right font-mono font-bold ${hColor}`}>
                              {r.cash_threshold.toFixed(3)}
                            </td>
                            <td className="px-2 py-1 text-right font-mono text-sky-700">
                              {r.forecasted_cash.toFixed(3)}
                            </td>
                            <td className="px-2 py-1 text-right font-mono text-gray-600">
                              {Math.abs(r.spot_pos) > 0.001 ? `${(-r.spot_pos).toFixed(3)}` : '—'}
                            </td>
                            <td className={`px-2 py-1 text-right font-mono ${swapColor}`}>
                              {Math.abs(r.swap_needed) < 0.005
                                ? '—'
                                : `${r.swap_needed >= 0 ? '+' : ''}${r.swap_needed.toFixed(3)}`}
                            </td>
                            <td className="px-2 py-1 text-right font-mono text-gray-400">
                              {Math.abs(r.swap_needed) < 0.005
                                ? '—'
                                : `${r.swap_needed >= 0 ? '−' : '+'}${Math.abs(r.swap_needed).toFixed(3)}`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-gray-700">
                        <td className="px-2 py-1.5">TOTAL</td>
                        <td colSpan={4} />
                        <td className="px-2 py-1.5 text-right font-mono">
                          {layerRows.reduce((s, r) => s + r.cash_threshold, 0).toFixed(3)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-sky-700">
                          {layerRows.reduce((s, r) => s + r.forecasted_cash, 0).toFixed(3)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">
                          {layerRows.reduce((s, r) => s + (-r.spot_pos), 0).toFixed(3)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-sky-800">
                          {(() => {
                            const t = layerRows.reduce((s, r) => s + r.swap_needed, 0);
                            return Math.abs(t) < 0.005 ? '—' : `${t >= 0 ? '+' : ''}${t.toFixed(3)}`;
                          })()}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>

              {/* ── Portfolio VAR summary ── */}
              {portfolioActive && portfolioResult && (
                <section>
                  <div className="text-xs font-bold text-violet-700 uppercase tracking-wide mb-1">
                    Portfolio VAR Summary
                  </div>
                  <div className="text-xs text-gray-500 mb-2">
                    1-month 95% VAR · {portfolioResult.currencies.length} currencies · pairwise correlation matrix ·
                    var_i_USD = H_final_i × σ_daily_i × √21 × z₉₅ × spot_i
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                    {[
                      { label: 'Standalone sum', value: `$${portfolioResult.standalone_sum_USD.toFixed(3)}M`, sub: 'No diversification', color: 'text-orange-700' },
                      { label: 'Portfolio VAR', value: `$${portfolioResult.portfolio_VAR_USD.toFixed(3)}M`, sub: portfolioResult.portfolio_VAR_USD >= policyVAR ? `⚠ EXCEEDS $${policyVAR}M limit` : `✓ Within $${policyVAR}M`, color: portfolioResult.portfolio_VAR_USD >= policyVAR ? 'text-red-700' : 'text-green-700' },
                      { label: 'Diversification saving', value: `$${portfolioResult.div_benefit_USD.toFixed(3)}M`, sub: `${(portfolioResult.div_factor * 100).toFixed(0)}% of standalone`, color: 'text-green-700' },
                      { label: 'Policy limit (active)', value: `$${policyVAR}M`, sub: 'Selected threshold', color: 'text-violet-700' },
                    ].map(card => (
                      <div key={card.label} className="rounded border border-violet-100 bg-violet-50 px-3 py-2">
                        <div className="text-gray-500">{card.label}</div>
                        <div className={`text-sm font-bold ${card.color}`}>{card.value}</div>
                        <div className={`text-gray-400 ${card.sub.startsWith('⚠') ? 'text-red-500' : card.sub.startsWith('✓') ? 'text-green-600' : ''}`}>{card.sub}</div>
                      </div>
                    ))}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                          <th className="px-2 py-1.5 text-left font-semibold">CCY</th>
                          <th className="px-2 py-1.5 text-right font-semibold">H_final FCY</th>
                          <th className="px-2 py-1.5 text-right font-semibold">H_final USD equiv</th>
                          <th className="px-2 py-1.5 text-right font-semibold text-orange-600">Standalone VAR $M</th>
                          <th className="px-2 py-1.5 text-right font-semibold text-violet-600">Component VAR $M</th>
                          <th className="px-2 py-1.5 text-right font-semibold">Beta</th>
                          <th className="px-2 py-1.5 text-right font-semibold text-green-600">Div saving $M</th>
                        </tr>
                      </thead>
                      <tbody>
                        {portfolioResult.currencies.map(c => {
                          const p = CURRENCY_PARAMS[c.ccy];
                          const lr = layerRows.find(r => r.ccy === c.ccy);
                          if (!p || !lr) return null;
                          const divSaving = c.standalone_VAR_USD - c.component_VAR_USD;
                          return (
                            <tr key={c.ccy} className="border-b border-gray-100 hover:bg-violet-50">
                              <td className="px-2 py-1 font-bold text-gray-800">{c.ccy}</td>
                              <td className="px-2 py-1 text-right font-mono">{lr.cash_threshold.toFixed(3)}</td>
                              <td className="px-2 py-1 text-right font-mono">${(lr.cash_threshold * p.spot).toFixed(3)}M</td>
                              <td className="px-2 py-1 text-right font-mono text-orange-700">${c.standalone_VAR_USD.toFixed(3)}M</td>
                              <td className="px-2 py-1 text-right font-mono text-violet-700">${c.component_VAR_USD.toFixed(3)}M</td>
                              <td className={`px-2 py-1 text-right font-mono ${
                                c.beta < 0 ? 'text-green-700 font-bold'
                                : c.beta < 0.7 ? 'text-green-600'
                                : c.beta > 0.9 ? 'text-orange-700'
                                : 'text-gray-700'
                              }`}>
                                {c.beta.toFixed(3)}
                              </td>
                              <td className={`px-2 py-1 text-right font-mono ${divSaving > 0.001 ? 'text-green-700' : 'text-gray-400'}`}>
                                {divSaving > 0.001 ? `$${divSaving.toFixed(3)}M` : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

            </div>

            {/* ── Modal footer ── */}
            <div className="px-5 py-2.5 border-t border-gray-200 bg-gray-50 rounded-b-xl flex justify-between items-center flex-shrink-0">
              <span className="text-xs text-gray-400">
                {layerRows.length} currencies · {activeLayers.size} active layer{activeLayers.size !== 1 ? 's' : ''}
                {portfolioActive && portfolioResult ? ` · Portfolio VAR $${portfolioResult.portfolio_VAR_USD.toFixed(3)}M` : ''}
              </span>
              <button
                onClick={() => setShowCalcModal(false)}
                className="px-4 py-1.5 bg-gray-200 hover:bg-gray-300 rounded text-xs font-medium text-gray-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
