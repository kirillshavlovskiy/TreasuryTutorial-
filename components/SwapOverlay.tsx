'use client';

import { useState, useCallback } from 'react';
import {
  CURRENCY_PARAMS,
  var95_1m_factor,
  combinedMultiplier,
  calcDynamicH,
  calcSwapNear,
  calcCarry,
  calcDelta,
} from '@/lib/fx-buffer';

interface SwapRow {
  id: string;
  ccy: string;
  C: number; // FX Spot position (M FCY, negative = short)
  D: number; // FX Forward (M FCY)
  E: number; // Non-Cash BS FX (M FCY)
  F: number; // Cash balance (M FCY)
  G: number; // Payout Forecast 1M (M FCY, negative = outflow)
}

const DEFAULT_ROWS: SwapRow[] = [
  { id: '1',  ccy: 'EUR', C: -15.00, D:  18.00, E:  0.50, F:  3.50, G: -4.00 },
  { id: '2',  ccy: 'GBP', C:  -8.00, D:  10.00, E:  0.30, F:  2.20, G: -2.50 },
  { id: '3',  ccy: 'AUD', C: -18.00, D:  21.00, E:  0.80, F:  4.50, G: -5.00 },
  { id: '4',  ccy: 'CAD', C: -12.00, D:  13.50, E:  0.40, F:  2.80, G: -3.20 },
  { id: '5',  ccy: 'JPY', C: -800.0, D: 900.00, E: 20.00, F: 150.0, G: -200. },
  { id: '6',  ccy: 'MXN', C: -25.00, D:  28.00, E:  1.20, F:  5.50, G: -7.00 },
  { id: '7',  ccy: 'TRY', C: -55.00, D:  65.00, E:  2.00, F: 12.00, G:-15.00 },
  { id: '8',  ccy: 'ZAR', C: -40.00, D:  45.00, E:  1.50, F:  8.00, G:-10.00 },
  { id: '9',  ccy: 'PLN', C: -20.00, D:  22.00, E:  0.80, F:  4.50, G: -5.50 },
  { id: '10', ccy: 'CHF', C:  -5.00, D:   6.50, E:  0.20, F:  1.80, G: -2.00 },
];

const EDITABLE_FIELDS: (keyof SwapRow)[] = ['C', 'D', 'E', 'F', 'G'];
const COL_COLORS = {
  input:    'bg-white',
  computed: 'bg-blue-50',
  H:        'bg-amber-50',
  swap:     'bg-emerald-50',
  carry:    'bg-purple-50',
  delta:    (v: number) => Math.abs(v) < 0.5 ? 'bg-green-50' : Math.abs(v) < 2 ? 'bg-yellow-50' : 'bg-red-50',
};

function n2(v: number) { return isNaN(v) ? '—' : v.toFixed(2); }
function pct1(v: number) { return (v * 100).toFixed(1) + '%'; }
function clr(v: number) { return v < 0 ? 'text-red-600' : 'text-gray-900'; }

export function SwapOverlay() {
  const [rows, setRows] = useState<SwapRow[]>(DEFAULT_ROWS);
  const [H_min, setH_min] = useState(0.05);      // 50K FCY floor
  const [carryRate, setCarryRate] = useState(0.4); // 0.4% monthly carry rate

  const editRow = useCallback((id: string, field: keyof SwapRow, raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val) && raw !== '' && raw !== '-') return;
    setRows(prev =>
      prev.map(r => r.id === id ? { ...r, [field]: isNaN(val) ? 0 : val } : r)
    );
  }, []);

  const resetRows = useCallback(() => setRows(DEFAULT_ROWS), []);

  // Compute derived values for each row
  const computed = rows.map(r => {
    const netPos = r.C + r.D;
    const p = CURRENCY_PARAMS[r.ccy];
    const vf  = p ? var95_1m_factor(p.σ_daily) : 0;
    const mul = p ? combinedMultiplier(p.carry, p.β_IR) : 1;
    const H   = calcDynamicH(netPos, r.ccy, H_min);
    const I   = calcSwapNear(r.C, r.D, r.F, r.G, H);
    const J   = -I;
    const L   = calcCarry(r.C, r.D, carryRate);
    const O   = calcDelta(r.C, r.D, L, r.E);
    return { ...r, netPos, vf, mul, H, I, J, L, O };
  });

  // Summary totals
  const totals = computed.reduce(
    (acc, r) => ({
      C: acc.C + r.C, D: acc.D + r.D, E: acc.E + r.E,
      F: acc.F + r.F, G: acc.G + r.G, H: acc.H + r.H,
      I: acc.I + r.I, J: acc.J + r.J, L: acc.L + r.L, O: acc.O + r.O,
    }),
    { C: 0, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, L: 0, O: 0 }
  );

  const thBase = 'px-2 py-1 text-xs font-semibold text-gray-600 uppercase tracking-wide whitespace-nowrap';
  const tdBase = 'px-2 py-1 text-right text-xs whitespace-nowrap';
  const inputCls = 'w-20 text-right text-xs border-0 bg-transparent focus:bg-white focus:ring-1 focus:ring-blue-400 rounded px-1 outline-none';

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-6 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">H min (M FCY)</label>
          <input
            type="number" step="0.01" min="0" value={H_min}
            onChange={e => setH_min(parseFloat(e.target.value) || 0)}
            className="w-20 rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">Carry rate K (%/month)</label>
          <input
            type="number" step="0.01" min="0" value={carryRate}
            onChange={e => setCarryRate(parseFloat(e.target.value) || 0)}
            className="w-20 rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
        <button
          onClick={resetRows}
          className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
        >
          Reset
        </button>
        <span className="ml-auto text-xs text-gray-400">
          Values in M FCY · Negative = short/outflow · Edit blue columns
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-100">
              <th className={`${thBase} sticky left-0 z-10 bg-gray-100 text-left min-w-[52px]`}>CCY</th>
              {/* Input columns */}
              <th className={`${thBase} bg-white`} colSpan={5}>──────────── INPUTS (M FCY) ────────────</th>
              {/* VAR info */}
              <th className={`${thBase} bg-blue-50`} colSpan={3}>── VAR PARAMS ──</th>
              {/* Threshold */}
              <th className={`${thBase} bg-amber-50`}>TARGET CASH</th>
              {/* Swap */}
              <th className={`${thBase} bg-emerald-50`} colSpan={2}>── SWAP ──</th>
              {/* P&L */}
              <th className={`${thBase} bg-purple-50`}>CARRY</th>
              <th className={`${thBase}`}>DELTA</th>
            </tr>
            <tr className="border-b-2 border-gray-300 bg-gray-50">
              <th className={`${thBase} sticky left-0 z-10 bg-gray-50 text-left`}>CCY</th>
              <th className={`${thBase} ${COL_COLORS.input}`}>C Spot</th>
              <th className={`${thBase} ${COL_COLORS.input}`}>D FWD</th>
              <th className={`${thBase} ${COL_COLORS.input}`}>E Non-Cash</th>
              <th className={`${thBase} ${COL_COLORS.input}`}>F Cash</th>
              <th className={`${thBase} ${COL_COLORS.input}`}>G Payout 1M</th>
              <th className={`${thBase} ${COL_COLORS.computed}`}>σ daily</th>
              <th className={`${thBase} ${COL_COLORS.computed}`}>VAR95 1M%</th>
              <th className={`${thBase} ${COL_COLORS.computed}`}>Mult</th>
              <th className={`${thBase} ${COL_COLORS.H}`}>H (M FCY)</th>
              <th className={`${thBase} ${COL_COLORS.swap}`}>I Near</th>
              <th className={`${thBase} ${COL_COLORS.swap}`}>J Far</th>
              <th className={`${thBase} ${COL_COLORS.carry}`}>L (M FCY)</th>
              <th className={`${thBase}`}>O Delta</th>
            </tr>
          </thead>
          <tbody>
            {computed.map(r => (
              <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className={`sticky left-0 z-10 bg-white px-2 py-1 text-xs font-bold text-gray-900 hover:bg-gray-50`}>
                  {r.ccy}
                </td>
                {/* Editable inputs */}
                {EDITABLE_FIELDS.map(f => (
                  <td key={f} className={`${tdBase} ${COL_COLORS.input}`}>
                    <input
                      type="number" step="0.1"
                      value={r[f] as number}
                      onChange={e => editRow(r.id, f, e.target.value)}
                      className={`${inputCls} ${(r[f] as number) < 0 ? 'text-red-600' : ''}`}
                    />
                  </td>
                ))}
                {/* VAR params */}
                <td className={`${tdBase} ${COL_COLORS.computed} text-gray-500`}>
                  {(r.vf ? r.ccy && CURRENCY_PARAMS[r.ccy] ? CURRENCY_PARAMS[r.ccy].σ_daily.toFixed(5) : '—' : '—')}
                </td>
                <td className={`${tdBase} ${COL_COLORS.computed}`}>
                  {pct1(r.vf)}
                </td>
                <td className={`${tdBase} ${COL_COLORS.computed}`}>
                  {r.mul.toFixed(4)}
                </td>
                {/* Threshold H */}
                <td className={`${tdBase} ${COL_COLORS.H} font-medium`}>
                  {n2(r.H)}
                </td>
                {/* Swap */}
                <td className={`${tdBase} ${COL_COLORS.swap} font-medium ${clr(r.I)}`}>
                  {n2(r.I)}
                </td>
                <td className={`${tdBase} ${COL_COLORS.swap} ${clr(r.J)}`}>
                  {n2(r.J)}
                </td>
                {/* Carry */}
                <td className={`${tdBase} ${COL_COLORS.carry} ${clr(r.L)}`}>
                  {n2(r.L)}
                </td>
                {/* Delta */}
                <td className={`${tdBase} ${COL_COLORS.delta(r.O)} font-semibold ${clr(r.O)}`}>
                  {n2(r.O)}
                </td>
              </tr>
            ))}

            {/* Summary row */}
            <tr className="border-t-2 border-gray-400 bg-gray-100 font-semibold">
              <td className="sticky left-0 z-10 bg-gray-100 px-2 py-1 text-xs font-bold text-gray-700">TOTAL</td>
              {(['C','D','E','F','G'] as const).map(k => (
                <td key={k} className={`${tdBase} ${clr(totals[k])}`}>{n2(totals[k])}</td>
              ))}
              <td className={`${tdBase} text-gray-400`} colSpan={3}>—</td>
              <td className={`${tdBase} ${COL_COLORS.H} font-bold`}>{n2(totals.H)}</td>
              <td className={`${tdBase} ${COL_COLORS.swap} font-bold ${clr(totals.I)}`}>{n2(totals.I)}</td>
              <td className={`${tdBase} ${COL_COLORS.swap} ${clr(totals.J)}`}>{n2(totals.J)}</td>
              <td className={`${tdBase} ${COL_COLORS.carry} ${clr(totals.L)}`}>{n2(totals.L)}</td>
              <td className={`${tdBase} font-bold ${clr(totals.O)}`}>{n2(totals.O)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        <span><span className="inline-block w-3 h-3 bg-amber-100 rounded mr-1 align-middle"/>H — VAR-based threshold: MAX(H_min, |C+D| × σ×√21×1.645 × (1+carry×β_IR))</span>
        <span><span className="inline-block w-3 h-3 bg-emerald-100 rounded mr-1 align-middle"/>I — Swap near: MAX(H−(F+G), −(C+D)) · J = −I</span>
        <span><span className="inline-block w-3 h-3 bg-purple-100 rounded mr-1 align-middle"/>L — Monthly carry: −(C+D) × K%</span>
        <span><span className="inline-block w-3 h-3 bg-gray-200 rounded mr-1 align-middle"/>O — Delta: C+D+L+E (I+J cancel)</span>
      </div>
    </div>
  );
}
