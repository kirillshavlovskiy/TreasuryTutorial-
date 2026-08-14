'use client';

import { useState, useCallback } from 'react';
import {
  CURRENCY_PARAMS,
  type RowState,
  type UsdParams,
  type SharedGlobals,
} from '@/lib/fx-buffer';

// ── IR computation (per row) ──────────────────────────────────────────────────

function computeIR(r: RowState, r_USD: number, days: number) {
  const p         = CURRENCY_PARAMS[r.ccy];
  const spot      = p?.spot ?? 1;
  const float_nim = r.cash * (r.r_FCY - r_USD) / 100 * spot;
  const fixed_nim = (r.ir_asset_notional * r.ir_asset_rate
                   - r.ir_liab_notional  * r.ir_liab_rate) / 100 * spot;
  const total_nim = float_nim + fixed_nim;
  const net_dv01  = (r.ir_asset_notional - r.ir_liab_notional) * r.ir_net_dur * spot * 0.0001;
  const mtm_100bp = net_dv01 * 100;
  const fwd_dv01  = Math.abs(r.fwd) * spot * (days / 365) * 0.0001;
  return { float_nim, fixed_nim, total_nim, net_dv01, mtm_100bp, fwd_dv01 };
}

// ── Formatters ────────────────────────────────────────────────────────────────

function f2(v: number) { return v.toFixed(2); }
function f4(v: number) { return v.toFixed(4); }
function clr(v: number) {
  return v > 0.001 ? 'text-green-700' : v < -0.001 ? 'text-red-600' : 'text-gray-400';
}
function nim(v: number) {
  return Math.abs(v) < 0.005
    ? <span className="text-gray-300">—</span>
    : <span className={clr(v)}>{f2(v)}</span>;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function IRProfilePanel({
  rows,
  setRows,
  usdParams,
  setUsdParams,
  usdCash,
  shared,
}: {
  rows:          RowState[];
  setRows:       React.Dispatch<React.SetStateAction<RowState[]>>;
  usdParams:     UsdParams;
  setUsdParams:  React.Dispatch<React.SetStateAction<UsdParams>>;
  usdCash:       number;
  shared:        SharedGlobals;
}) {
  // Draft state for text-field editing (same pattern as UnifiedSimulator)
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const editRow = useCallback((id: string, field: keyof RowState, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.${field}`]: raw }));
  }, []);

  const blurRow = useCallback((id: string, field: keyof RowState) => {
    setDrafts(prev => {
      const key = `${id}.${field}`;
      const raw = prev[key];
      if (raw !== undefined) {
        const val = parseFloat(raw);
        if (!isNaN(val)) {
          setRows(rs => rs.map(r => r.id === id ? { ...r, [field]: val } : r));
        }
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return prev;
    });
  }, [setRows]);

  const editUsd = useCallback((field: keyof UsdParams, raw: string) => {
    setDrafts(prev => ({ ...prev, [`usd.${field}`]: raw }));
  }, []);

  const blurUsd = useCallback((field: keyof UsdParams) => {
    setDrafts(prev => {
      const key = `usd.${field}`;
      const raw = prev[key];
      if (raw !== undefined) {
        const val = parseFloat(raw);
        if (!isNaN(val)) {
          setUsdParams(p => ({ ...p, [field]: val }));
        }
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return prev;
    });
  }, [setUsdParams]);

  // Build USD RowState for computation
  const usdRow: RowState = {
    id: 'USD', ccy: 'USD',
    σ_daily: 0, r_FCY: shared.r_USD, r_OD: usdParams.r_OD, β_IR: 0,
    spot: 0, fwd: 0, nonCash: 0,
    cash: usdCash, payout: usdParams.payout,
    collections: usdParams.collections, fcastFX: 0, nonLpCash: 0, cash_floor: 0,
    ir_asset_notional: usdParams.ir_asset_notional,
    ir_asset_rate:     usdParams.ir_asset_rate,
    ir_liab_notional:  usdParams.ir_liab_notional,
    ir_liab_rate:      usdParams.ir_liab_rate,
    ir_net_dur:        usdParams.ir_net_dur,
  };

  // Computed per-row IR values
  const allRows = rows.map(r => ({ ...r, ir: computeIR(r, shared.r_USD, shared.days) }));
  const usdIR   = computeIR(usdRow, shared.r_USD, shared.days);

  // Portfolio totals (FCY rows only — USD tracked separately)
  const totals = allRows.reduce(
    (acc, r) => ({
      float_nim: acc.float_nim + r.ir.float_nim,
      fixed_nim: acc.fixed_nim + r.ir.fixed_nim,
      total_nim: acc.total_nim + r.ir.total_nim,
      net_dv01:  acc.net_dv01  + r.ir.net_dv01,
      mtm_100bp: acc.mtm_100bp + r.ir.mtm_100bp,
      fwd_dv01:  acc.fwd_dv01  + r.ir.fwd_dv01,
    }),
    { float_nim: 0, fixed_nim: 0, total_nim: 0, net_dv01: 0, mtm_100bp: 0, fwd_dv01: 0 }
  );

  // Style helpers
  const th   = 'px-2 py-1 text-right text-xs font-semibold text-gray-600 whitespace-nowrap';
  const thL  = 'px-2 py-1 text-left  text-xs font-semibold text-gray-600 whitespace-nowrap';
  const td   = 'px-2 py-1 text-right text-xs whitespace-nowrap';
  const inB  = 'text-right text-xs border-0 bg-transparent focus:bg-white focus:ring-1 focus:ring-rose-400 rounded px-1 outline-none';

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-bold text-gray-800">
          IR Profile — Interest Rate Asset/Liability
        </h2>
        <span className="rounded bg-rose-50 px-2 py-0.5 text-xs text-rose-600">
          all computed values in $M USD · r_USD = {shared.r_USD.toFixed(2)}%
        </span>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-6 gap-3">
        {[
          { label: 'Float NIM (FCY)',   v: totals.float_nim, sub: 'LP cash carry vs USD' },
          { label: 'Fixed NIM (FCY)',   v: totals.fixed_nim, sub: '(A×rA − L×rL)×spot'  },
          { label: 'Total NIM',         v: totals.total_nim, sub: 'Float + Fixed'         },
          { label: 'Net DV01',          v: totals.net_dv01,  sub: '$M per 1bp shift'     },
          { label: 'MTM 100bp',         v: totals.mtm_100bp, sub: 'Parallel rate shock'  },
          { label: 'Fwd DV01',          v: totals.fwd_dv01,  sub: 'Cross-CCY Δr sensitivity' },
        ].map(s => (
          <div key={s.label} className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2">
            <div className="text-xs text-rose-500">{s.label}</div>
            <div className={`text-lg font-bold ${clr(s.v)}`}>{f2(s.v)}<span className="ml-1 text-xs font-normal text-rose-400">$M</span></div>
            <div className="text-xs text-gray-400">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Main table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full">
          <thead>
            {/* Group header */}
            <tr className="border-b border-gray-200 bg-gray-100">
              <th className={thL} rowSpan={2}>CCY</th>
              <th className="px-2 py-1 text-center text-xs font-semibold text-rose-600 bg-rose-50 whitespace-nowrap" colSpan={5}>
                FIXED-RATE BOOK INPUTS (M FCY)
              </th>
              <th className="px-2 py-1 text-center text-xs font-semibold text-rose-700 bg-rose-100 whitespace-nowrap" colSpan={6}>
                COMPUTED — all in $M USD/yr or $M
              </th>
            </tr>
            {/* Column names */}
            <tr className="border-b-2 border-gray-300 bg-gray-50 text-xs">
              <th className={`${th} bg-rose-50 min-w-[72px]`}>
                Fixed Assets<br/><span className="font-normal text-rose-400">M FCY · deposits/bonds</span>
              </th>
              <th className={`${th} bg-rose-50 min-w-[64px]`}>
                Asset Rate<br/><span className="font-normal text-rose-400">% p.a. coupon</span>
              </th>
              <th className={`${th} bg-rose-50 min-w-[72px]`}>
                Fixed Liabs<br/><span className="font-normal text-rose-400">M FCY · borrowings</span>
              </th>
              <th className={`${th} bg-rose-50 min-w-[64px]`}>
                Liab Rate<br/><span className="font-normal text-rose-400">% p.a. funding</span>
              </th>
              <th className={`${th} bg-rose-50 min-w-[64px]`}>
                Net Duration<br/><span className="font-normal text-rose-400">mod. dur. yrs</span>
              </th>
              <th className={`${th} bg-rose-100 border-l border-rose-200 min-w-[76px]`}>
                Float NIM<br/><span className="font-normal text-rose-500">$M/yr · cash×(r_FCY−r_USD)×spot</span>
              </th>
              <th className={`${th} bg-rose-100 min-w-[76px]`}>
                Fixed NIM<br/><span className="font-normal text-rose-500">$M/yr · (A×rA−L×rL)×spot</span>
              </th>
              <th className={`${th} bg-rose-100 min-w-[76px]`}>
                Total NIM<br/><span className="font-normal text-rose-500">$M/yr · Float + Fixed</span>
              </th>
              <th className={`${th} bg-rose-100 min-w-[68px]`}>
                Net DV01<br/><span className="font-normal text-rose-500">$M/bp · (A−L)×dur×spot</span>
              </th>
              <th className={`${th} bg-rose-100 min-w-[76px]`}>
                MTM 100bp<br/><span className="font-normal text-rose-500">$M · parallel shock</span>
              </th>
              <th className={`${th} bg-rose-100 min-w-[72px]`}>
                Fwd DV01<br/><span className="font-normal text-rose-500">$M/bp · cross-CCY Δr</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {allRows.map(r => (
              <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-2 py-0.5 text-xs font-bold text-gray-900 sticky left-0 bg-white">{r.ccy}</td>

                {/* ── Inputs ── */}
                <td className="px-1 py-0.5 bg-rose-50">
                  <input type="text" inputMode="decimal"
                    value={drafts[`${r.id}.ir_asset_notional`] ?? r.ir_asset_notional}
                    onChange={e => editRow(r.id, 'ir_asset_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_asset_notional')}
                    className={`${inB} w-[64px]`} />
                </td>
                <td className="px-1 py-0.5 bg-rose-50">
                  <input type="text" inputMode="decimal"
                    value={drafts[`${r.id}.ir_asset_rate`] ?? r.ir_asset_rate}
                    onChange={e => editRow(r.id, 'ir_asset_rate', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_asset_rate')}
                    className={`${inB} w-[52px]`} />
                </td>
                <td className="px-1 py-0.5 bg-rose-50">
                  <input type="text" inputMode="decimal"
                    value={drafts[`${r.id}.ir_liab_notional`] ?? r.ir_liab_notional}
                    onChange={e => editRow(r.id, 'ir_liab_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_liab_notional')}
                    className={`${inB} w-[64px]`} />
                </td>
                <td className="px-1 py-0.5 bg-rose-50">
                  <input type="text" inputMode="decimal"
                    value={drafts[`${r.id}.ir_liab_rate`] ?? r.ir_liab_rate}
                    onChange={e => editRow(r.id, 'ir_liab_rate', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_liab_rate')}
                    className={`${inB} w-[52px]`} />
                </td>
                <td className="px-1 py-0.5 bg-rose-50">
                  <input type="text" inputMode="decimal"
                    value={drafts[`${r.id}.ir_net_dur`] ?? r.ir_net_dur}
                    onChange={e => editRow(r.id, 'ir_net_dur', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_net_dur')}
                    className={`${inB} w-[52px]`} />
                </td>

                {/* ── Computed ── */}
                <td className={`${td} bg-rose-100 border-l border-rose-200 font-medium`}>{nim(r.ir.float_nim)}</td>
                <td className={`${td} bg-rose-100`}>{nim(r.ir.fixed_nim)}</td>
                <td className={`${td} bg-rose-100 font-semibold`}>{nim(r.ir.total_nim)}</td>
                <td className={`${td} bg-rose-100 text-gray-600`}>
                  {Math.abs(r.ir.net_dv01) < 0.0001
                    ? <span className="text-gray-300">—</span>
                    : <span>{f4(r.ir.net_dv01)}</span>}
                </td>
                <td className={`${td} bg-rose-100 font-medium`}>
                  {r.ir.mtm_100bp === 0
                    ? <span className="text-gray-300">—</span>
                    : <span className={clr(r.ir.mtm_100bp)}>{f2(r.ir.mtm_100bp)}</span>}
                </td>
                <td className={`${td} bg-rose-100 text-gray-500`}>
                  {r.ir.fwd_dv01 < 0.0001
                    ? <span className="text-gray-300">—</span>
                    : <span>{f4(r.ir.fwd_dv01)}</span>}
                </td>
              </tr>
            ))}

            {/* ── USD row ── */}
            <tr className="border-t-2 border-blue-300 bg-blue-50/40">
              <td className="px-2 py-0.5 text-xs font-bold text-blue-800 sticky left-0 bg-blue-100">USD</td>

              <td className="px-1 py-0.5 bg-rose-50">
                <input type="text" inputMode="decimal"
                  value={drafts['usd.ir_asset_notional'] ?? usdParams.ir_asset_notional}
                  onChange={e => editUsd('ir_asset_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_asset_notional')}
                  className={`${inB} w-[64px]`} />
              </td>
              <td className="px-1 py-0.5 bg-rose-50">
                <input type="text" inputMode="decimal"
                  value={drafts['usd.ir_asset_rate'] ?? usdParams.ir_asset_rate}
                  onChange={e => editUsd('ir_asset_rate', e.target.value)}
                  onBlur={() => blurUsd('ir_asset_rate')}
                  className={`${inB} w-[52px]`} />
              </td>
              <td className="px-1 py-0.5 bg-rose-50">
                <input type="text" inputMode="decimal"
                  value={drafts['usd.ir_liab_notional'] ?? usdParams.ir_liab_notional}
                  onChange={e => editUsd('ir_liab_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_notional')}
                  className={`${inB} w-[64px]`} />
              </td>
              <td className="px-1 py-0.5 bg-rose-50">
                <input type="text" inputMode="decimal"
                  value={drafts['usd.ir_liab_rate'] ?? usdParams.ir_liab_rate}
                  onChange={e => editUsd('ir_liab_rate', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_rate')}
                  className={`${inB} w-[52px]`} />
              </td>
              <td className="px-1 py-0.5 bg-rose-50">
                <input type="text" inputMode="decimal"
                  value={drafts['usd.ir_net_dur'] ?? usdParams.ir_net_dur}
                  onChange={e => editUsd('ir_net_dur', e.target.value)}
                  onBlur={() => blurUsd('ir_net_dur')}
                  className={`${inB} w-[52px]`} />
              </td>
              <td className={`${td} bg-rose-100 border-l border-rose-200 font-medium`}>{nim(usdIR.float_nim)}</td>
              <td className={`${td} bg-rose-100`}>{nim(usdIR.fixed_nim)}</td>
              <td className={`${td} bg-rose-100 font-semibold`}>{nim(usdIR.total_nim)}</td>
              <td className={`${td} bg-rose-100 text-gray-600`}>
                {Math.abs(usdIR.net_dv01) < 0.0001
                  ? <span className="text-gray-300">—</span>
                  : <span>{f4(usdIR.net_dv01)}</span>}
              </td>
              <td className={`${td} bg-rose-100 font-medium`}>
                {usdIR.mtm_100bp === 0
                  ? <span className="text-gray-300">—</span>
                  : <span className={clr(usdIR.mtm_100bp)}>{f2(usdIR.mtm_100bp)}</span>}
              </td>
              <td className={`${td} bg-rose-100 text-gray-500`}>
                {usdIR.fwd_dv01 < 0.0001
                  ? <span className="text-gray-300">—</span>
                  : <span>{f4(usdIR.fwd_dv01)}</span>}
              </td>
            </tr>

            {/* ── Portfolio totals (FCY book) ── */}
            <tr className="border-t-2 border-gray-400 bg-gray-100 font-semibold">
              <td className="px-2 py-1 text-xs font-bold text-gray-700 sticky left-0 bg-gray-100">FCY TOTAL</td>
              <td className="bg-rose-50" colSpan={5} />
              <td className={`${td} bg-rose-100 border-l border-rose-200 font-bold`}>
                {Math.abs(totals.float_nim) < 0.005
                  ? <span className="text-gray-300">—</span>
                  : <span className={clr(totals.float_nim)}>{f2(totals.float_nim)}<span className="ml-0.5 text-xs font-normal text-gray-400">$M</span></span>}
              </td>
              <td className={`${td} bg-rose-100 font-bold`}>
                {totals.fixed_nim === 0
                  ? <span className="text-gray-300">—</span>
                  : <span className={clr(totals.fixed_nim)}>{f2(totals.fixed_nim)}<span className="ml-0.5 text-xs font-normal text-gray-400">$M</span></span>}
              </td>
              <td className={`${td} bg-rose-100 font-bold`}>
                {Math.abs(totals.total_nim) < 0.005
                  ? <span className="text-gray-300">—</span>
                  : <span className={clr(totals.total_nim)}>{f2(totals.total_nim)}<span className="ml-0.5 text-xs font-normal text-gray-400">$M</span></span>}
              </td>
              <td className={`${td} bg-rose-100 font-bold text-gray-700`}>
                {Math.abs(totals.net_dv01) < 0.0001
                  ? <span className="text-gray-300">—</span>
                  : <span>{f4(totals.net_dv01)}<span className="ml-0.5 text-xs font-normal text-gray-400">$M</span></span>}
              </td>
              <td className={`${td} bg-rose-100 font-bold`}>
                {totals.mtm_100bp === 0
                  ? <span className="text-gray-300">—</span>
                  : <span className={clr(totals.mtm_100bp)}>{f2(totals.mtm_100bp)}<span className="ml-0.5 text-xs font-normal text-gray-400">$M</span></span>}
              </td>
              <td className={`${td} bg-rose-100 text-gray-600`}>
                {totals.fwd_dv01 < 0.0001
                  ? <span className="text-gray-300">—</span>
                  : <span>{f4(totals.fwd_dv01)}<span className="ml-0.5 text-xs font-normal text-gray-400">$M</span></span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="text-xs text-gray-400 space-y-0.5 border-t border-gray-100 pt-2">
        <p><strong className="text-gray-500">Float NIM</strong> = LP cash × (r_FCY − r_USD) / 100 × spot · annualised net interest margin on floating LP cash position</p>
        <p><strong className="text-gray-500">Fixed NIM</strong> = (fixed_assets × asset_rate − fixed_liabs × liab_rate) / 100 × spot · net income from fixed-rate book</p>
        <p><strong className="text-gray-500">Net DV01</strong> = (fixed_assets − fixed_liabs) × net_duration × spot × 0.0001 · P&L per 1bp parallel rate shift</p>
        <p><strong className="text-gray-500">MTM 100bp</strong> = Net DV01 × 100 · mark-to-market P&L impact of 100bp parallel shock across fixed-rate book</p>
        <p><strong className="text-gray-500">Fwd DV01</strong> = |forward| × spot × (days/365) × 0.0001 · sensitivity of FX forward MTM to 1bp change in rate differential</p>
      </div>
    </div>
  );
}
