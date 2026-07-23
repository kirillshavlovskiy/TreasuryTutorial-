'use client';

import { useState } from 'react';
import { CURRENCY_PARAMS } from '@/lib/fx-buffer';

// ── Types ────────────────────────────────────────────────────────────────────

interface HedgeRow {
  id: string;
  ccy: string;
  cash: number;         // F: current NP cash balance (M FCY)
  payout: number;       // G: forecast monthly outflow (M FCY, negative)
  collections: number;  // expected inflows arriving AFTER payouts (M FCY, positive)
  nonNpCash: number;    // Model 2/3 FCY outside NP (M FCY)
  fxRatio: number;      // 0–1: fraction of structural change hedged via outright FX
                        //   auto-locked to 0 for EARN CARRY; user-editable for PAY CARRY
}

const DEMO_ROWS: HedgeRow[] = [
  { id: '1', ccy: 'EUR', cash:  3.50, payout:  -4.00, collections: 1.50, nonNpCash: 0.00, fxRatio: 0 },
  { id: '2', ccy: 'GBP', cash:  2.20, payout:  -2.50, collections: 1.00, nonNpCash: 0.50, fxRatio: 0 },
  { id: '3', ccy: 'AUD', cash:  4.50, payout:  -5.00, collections: 2.00, nonNpCash: 0.00, fxRatio: 0 },
  { id: '4', ccy: 'CAD', cash:  2.80, payout:  -3.20, collections: 1.20, nonNpCash: 0.00, fxRatio: 0 },
  { id: '5', ccy: 'JPY', cash: 150.0, payout: -200.0, collections: 50.0, nonNpCash: 0.00, fxRatio: 0 },
  { id: '6', ccy: 'MXN', cash:  5.50, payout:  -7.00, collections: 3.00, nonNpCash: 1.00, fxRatio: 0 },
  { id: '7', ccy: 'TRY', cash: 12.00, payout: -15.00, collections: 5.00, nonNpCash: 0.00, fxRatio: 0 },
  { id: '8', ccy: 'ZAR', cash:  8.00, payout: -10.00, collections: 4.00, nonNpCash: 0.00, fxRatio: 0 },
  { id: '9', ccy: 'CHF', cash:  1.80, payout:  -2.00, collections: 0.50, nonNpCash: 0.00, fxRatio: 0 },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function n2(v: number) { return (v >= 0 ? '+' : '') + v.toFixed(2); }
function f2(v: number) { return v.toFixed(2); }
function clr(v: number) { return v > 0.001 ? 'text-green-700' : v < -0.001 ? 'text-red-600' : 'text-gray-400'; }
function bg(v: number)  { return v < -0.001 ? 'bg-red-50' : v > 0.001 ? 'bg-green-50' : ''; }

function EarnBadge({ earn }: { earn: boolean }) {
  return earn
    ? <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">EARN</span>
    : <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">PAY</span>;
}

// ── Component ────────────────────────────────────────────────────────────────

export function HedgingDecisionPanel({ r_USD = 3.50 }: { r_USD?: number }) {
  const [rows, setRows] = useState<HedgeRow[]>(DEMO_ROWS);

  const edit = (id: string, field: keyof HedgeRow, val: number) =>
    setRows(prev => prev.map(r => r.id === id ? { ...r, [field]: val } : r));

  const computed = rows.map(r => {
    const p     = CURRENCY_PARAMS[r.ccy];
    const r_FCY = p?.carry ?? 0;
    const delta_r     = r_FCY - r_USD;          // positive = EARN, negative = PAY
    const earn_carry  = delta_r >= 0;

    // ── TIMING layer (FX Swap) ────────────────────────────────────────────
    // Trough: after payouts, before collections arrive — worst-case NP cash
    const trough      = r.cash + r.payout;
    // Month-end: after all flows settle
    const month_end   = r.cash + r.payout + r.collections + r.nonNpCash;
    // Swap needed to cover trough (buy FCY near if trough < 0, zero if already positive)
    const swap_needed = Math.max(-trough, 0);
    // As collections arrive they reduce the open near-leg need
    const swap_remaining = Math.max(swap_needed - r.collections, 0);

    // ── STRUCTURAL layer (FX Hedge) ───────────────────────────────────────
    // Net structural change = total monthly FCY position change (payouts + inflows + non-NP)
    const net_structural = r.payout + r.collections + r.nonNpCash;
    // FX ratio: user-controlled for all currencies; earn carry default is 0 but can be overridden
    const ratio = r.fxRatio;
    // Amount hedged outright via spot/forward — reduces delta
    const fx_hedged  = net_structural * ratio;
    // Residual: either held for carry (earn) or left partially unhedged (pay + ratio < 1)
    const unhedged   = net_structural * (1 - ratio);

    // ── Delta impact from monthly change ─────────────────────────────────
    // Swap contribution: always 0 (near + far cancel)
    // FX hedge contribution: reduces delta by ratio
    // Unhedged contribution: full delta = 1
    const delta_from_monthly = unhedged;   // swap=0 + fx_hedged reduces delta

    return {
      ...r, r_FCY, delta_r, earn_carry,
      trough, month_end,
      swap_needed, swap_remaining,
      net_structural, ratio, fx_hedged, unhedged,
      delta_from_monthly,
    };
  });

  const th = 'px-2 py-1 text-left text-xs font-semibold text-gray-600 whitespace-nowrap';
  const td = 'px-2 py-1 text-right text-xs whitespace-nowrap';
  const inp = 'text-right text-xs border border-gray-200 rounded px-1 py-0.5 w-[58px]';

  return (
    <div className="space-y-4">

      {/* Title */}
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-bold text-gray-800">Monthly FX Position Change — Two-Layer Hedging</h2>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">r_USD = {r_USD.toFixed(2)}%</span>
      </div>

      {/* Layer explanation */}
      <div className="grid grid-cols-2 gap-4">

        {/* Layer 1: Swap */}
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-xs space-y-1.5">
          <div className="font-semibold text-orange-800 text-sm">Layer 1 — FX Swap (Timing)  ·  Δdelta = 0</div>
          <div className="text-gray-600">
            Payouts leave the NP before collections arrive. Swap near leg buys FCY to cover
            the trough gap. As collections flow in, the near-leg need unwinds — swap remaining
            shrinks toward zero by month-end.
          </div>
          <div className="font-mono text-orange-700 space-y-0.5">
            <div>trough        = cash + payout</div>
            <div>swap_needed   = MAX(−trough, 0)</div>
            <div>swap_remaining = MAX(swap_needed − collections, 0)</div>
            <div>Δdelta = 0   (near + far cancel)</div>
          </div>
          <div className="text-gray-500 italic">Applies to all currencies regardless of carry direction.</div>
        </div>

        {/* Layer 2: FX Hedge */}
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs space-y-1.5">
          <div className="font-semibold text-blue-800 text-sm">Layer 2 — FX Hedge (Structural)  ·  0 ≤ Δdelta ≤ 1</div>
          <div className="text-gray-600">
            The net difference between payins and payouts is a structural FCY position change
            that closes gradually over time through ongoing FX hedging. Carry condition governs
            how much is hedged vs held.
          </div>
          <div className="font-mono text-blue-700 space-y-0.5">
            <div>net_structural = payout + collections + nonNP</div>
            <div>fx_hedged      = net_structural × ratio</div>
            <div>unhedged       = net_structural × (1 − ratio)</div>
            <div>ratio = 0 (default) for EARN CARRY → hold for carry income</div>
            <div>ratio &gt; 0 (user-set) → hedge that fraction outright, any carry direction</div>
          </div>
          <div className="text-gray-500 italic">FX hedge is applied ON TOP of the swap — both layers are additive.</div>
        </div>
      </div>

      {/* Decision table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full">
          <thead>
            {/* Group row */}
            <tr className="bg-gray-100 border-b border-gray-200 text-xs">
              <th className={th} rowSpan={2}>CCY</th>
              <th className={`${th} bg-white text-center`} colSpan={4}>INPUTS (M FCY)</th>
              <th className={`${th} bg-sky-50 text-center`} colSpan={2}>TIMING</th>
              <th className={`${th} bg-yellow-50 text-center`} colSpan={3}>CARRY</th>
              <th className={`${th} bg-orange-50 text-center`} colSpan={2}>SWAP LAYER · Δ=0</th>
              <th className={`${th} bg-blue-50 text-center`} colSpan={3}>FX HEDGE LAYER · 0&lt;Δ&lt;1</th>
              <th className={`${th} bg-purple-50 text-center`}>DELTA</th>
            </tr>
            <tr className="bg-gray-50 border-b-2 border-gray-300 text-xs">
              <th className={`${th} bg-white`}>Cash F</th>
              <th className={`${th} bg-white`}>Payout G</th>
              <th className={`${th} bg-white`}>Collections</th>
              <th className={`${th} bg-white`}>Non-NP</th>
              <th className={`${th} bg-sky-50`}>Trough</th>
              <th className={`${th} bg-sky-50`}>Month-End</th>
              <th className={`${th} bg-yellow-50`}>r_FCY</th>
              <th className={`${th} bg-yellow-50`}>Δr</th>
              <th className={`${th} bg-yellow-50`}></th>
              <th className={`${th} bg-orange-50`}>Swap now</th>
              <th className={`${th} bg-orange-50`}>After coll.</th>
              <th className={`${th} bg-blue-50`}>Structural</th>
              <th className={`${th} bg-blue-50`}>Ratio</th>
              <th className={`${th} bg-blue-50`}>FX hedged</th>
              <th className={`${th} bg-purple-50 font-bold`}>Δ monthly</th>
            </tr>
          </thead>
          <tbody>
            {computed.map(r => (
              <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-2 py-1 text-xs font-bold text-gray-900">{r.ccy}</td>

                {/* Cash */}
                <td className={`${td} bg-white`}>
                  <input type="number" step="0.5" value={r.cash}
                    onChange={e => edit(r.id, 'cash', parseFloat(e.target.value) || 0)}
                    className={`${inp} ${r.cash < 0 ? 'text-red-600' : ''}`} />
                </td>
                {/* Payout */}
                <td className={`${td} bg-white`}>
                  <input type="number" step="0.5" value={r.payout}
                    onChange={e => edit(r.id, 'payout', parseFloat(e.target.value) || 0)}
                    className={`${inp} text-red-600`} />
                </td>
                {/* Collections */}
                <td className={`${td} bg-white`}>
                  <input type="number" step="0.5" value={r.collections}
                    onChange={e => edit(r.id, 'collections', parseFloat(e.target.value) || 0)}
                    className={`${inp} text-green-700`} />
                </td>
                {/* Non-NP */}
                <td className={`${td} bg-white`}>
                  <input type="number" step="0.5" value={r.nonNpCash}
                    onChange={e => edit(r.id, 'nonNpCash', parseFloat(e.target.value) || 0)}
                    className={inp} />
                </td>

                {/* Trough */}
                <td className={`${td} bg-sky-50 font-medium ${clr(r.trough)}`}>{n2(r.trough)}</td>
                {/* Month-end */}
                <td className={`${td} bg-sky-50 ${clr(r.month_end)}`}>{n2(r.month_end)}</td>

                {/* r_FCY */}
                <td className={`${td} bg-yellow-50 ${r.earn_carry ? 'text-green-700' : 'text-red-600'}`}>
                  {r.r_FCY.toFixed(2)}%
                </td>
                {/* Δr */}
                <td className={`${td} bg-yellow-50 font-semibold ${r.earn_carry ? 'text-green-700' : 'text-red-600'}`}>
                  {r.delta_r >= 0 ? '+' : ''}{r.delta_r.toFixed(2)}%
                </td>
                {/* Earn/Pay badge */}
                <td className="px-2 py-1 bg-yellow-50">
                  <EarnBadge earn={r.earn_carry} />
                </td>

                {/* Swap needed now */}
                <td className={`${td} bg-orange-50 font-medium ${r.swap_needed > 0.001 ? 'text-orange-700' : 'text-gray-400'}`}>
                  {r.swap_needed > 0.001 ? '+' + f2(r.swap_needed) : '—'}
                </td>
                {/* Swap remaining after collections */}
                <td className={`${td} bg-orange-50 ${r.swap_remaining > 0.001 ? 'text-orange-600' : 'text-gray-400'}`}>
                  {r.swap_needed > 0.001
                    ? (r.swap_remaining > 0.001 ? '+' + f2(r.swap_remaining) : '✓ 0')
                    : '—'}
                </td>

                {/* Structural net change */}
                <td className={`${td} bg-blue-50 font-medium ${clr(r.net_structural)}`}>
                  {n2(r.net_structural)}
                </td>
                {/* FX ratio slider — available for all currencies */}
                <td className={`${td} bg-blue-50`}>
                  <div className="flex items-center gap-1 justify-end">
                    <input type="range" min={0} max={1} step={0.05} value={r.fxRatio}
                      onChange={e => edit(r.id, 'fxRatio', parseFloat(e.target.value))}
                      className="w-12 accent-blue-600" />
                    <span className={`w-7 text-right text-xs ${r.fxRatio > 0 ? 'text-blue-700' : 'text-gray-400'}`}>
                      {Math.round(r.fxRatio * 100)}%
                    </span>
                  </div>
                </td>
                {/* FX hedged amount */}
                <td className={`${td} bg-blue-50 ${r.fx_hedged !== 0 ? clr(r.fx_hedged) : 'text-gray-300'}`}>
                  {Math.abs(r.fx_hedged) > 0.001 ? n2(r.fx_hedged) : '—'}
                </td>

                {/* Delta from monthly change (unhedged portion) */}
                <td className={`${td} bg-purple-50 font-bold ${clr(r.delta_from_monthly)}`}>
                  {n2(r.delta_from_monthly)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Notes */}
      <div className="text-xs text-gray-400 space-y-0.5 border-t border-gray-100 pt-2">
        <p><strong className="text-gray-500">Trough</strong> = cash + payout — lowest NP balance during month (before collections arrive)</p>
        <p><strong className="text-gray-500">Swap needed</strong> = MAX(−trough, 0) — near leg buys FCY to bridge the gap · far leg sells back at month-end · Δdelta = 0</p>
        <p><strong className="text-gray-500">Swap remaining</strong> = MAX(swap_needed − collections, 0) — open near-leg exposure as collections flow in and unwind it</p>
        <p><strong className="text-gray-500">Structural</strong> = payout + collections + nonNP — net FCY position change over the month</p>
        <p><strong className="text-gray-500">FX hedged</strong> = structural × ratio — outright spot/forward · default ratio = 0 for all; user-set to partially hedge regardless of carry direction</p>
        <p><strong className="text-gray-500">Δ monthly</strong> = structural × (1 − ratio) — delta contribution from monthly change after FX hedge; swap adds 0</p>
      </div>
    </div>
  );
}
