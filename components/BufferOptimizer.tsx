'use client';

import { useState, useMemo } from 'react';
import { LineChart } from '@/components/LineChart';
import { DeskProgressTrack, DeskStepper } from '@/components/DeskStepper';
import {
  CURRENCY_PARAMS,
  calcOptimalBuffer,
  calcMultiCcyTable,
  genSensitivity,
  type BufferOptParams,
  type SensParam,
  type SharedGlobals,
} from '@/lib/fx-buffer';

interface PrivateParams {
  P: number;
  r_FCY: number;
  r_OD: number;
}

const DEFAULT_PRIVATE: PrivateParams = {
  P: 10,
  r_FCY: CURRENCY_PARAMS['EUR']?.carry  ?? 1.783, // JPM NP credit rate — EUR Jan 2026
  r_OD:  CURRENCY_PARAMS['EUR']?.r_OD   ?? 2.213, // JPM NP debit rate  — EUR Jan 2026
};

const SENS_META: Record<SensParam, { label: string; xLabel: string; xUnit: string; xDecimals: number }> = {
  deltaR: {
    label: 'Carry Differential (Δr)',
    xLabel: 'r_USD − r_FCY (carry differential %)',
    xUnit: '%', xDecimals: 1,
  },
  sigmaP: {
    label: 'Forecast Uncertainty (σ_P)',
    xLabel: 'Payout forecast uncertainty σ_P',
    xUnit: '', xDecimals: 2,
  },
  r_OD: {
    label: 'Overdraft Rate',
    xLabel: 'Overdraft facility rate % p.a.',
    xUnit: '%', xDecimals: 1,
  },
};

function fmt1(v: number) { return v.toFixed(1); }
function fmt2(v: number) { return v.toFixed(2); }

function CarryBadge({ dir }: { dir: 'earn' | 'pay' | 'neutral' }) {
  if (dir === 'earn') return <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">EARN CARRY</span>;
  if (dir === 'pay')  return <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">PAY CARRY</span>;
  return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">NEUTRAL</span>;
}

function Slider({
  label, sublabel, value, min, max, step, unit, onChange,
}: {
  label: string; sublabel?: string; value: number; min: number; max: number;
  step: number; unit: string; onChange: (v: number) => void;
}) {
  return (
    <DeskStepper
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={onChange}
      formatValue={v => (unit === '%' ? `${v.toFixed(2)}%` : v.toFixed(2))}
      suffix={unit && unit !== '%' ? unit : undefined}
      editable
      title={sublabel}
      className="w-full"
      editClassName="w-14"
    />
  );
}

export function BufferOptimizer({ shared, onSharedChange }: {
  shared: SharedGlobals;
  onSharedChange: (key: keyof SharedGlobals, value: number) => void;
}) {
  const [privateParams, setPrivateParams] = useState<PrivateParams>(DEFAULT_PRIVATE);
  const [sensParam, setSensParam] = useState<SensParam>('deltaR');

  const setPrivate = (field: keyof PrivateParams, v: number) =>
    setPrivateParams(p => ({ ...p, [field]: v }));

  // Assembled full params for all calculations
  const params: BufferOptParams = {
    P:     privateParams.P,
    σ_P:   shared.σ_P,
    r_USD: shared.r_USD,
    r_FCY: privateParams.r_FCY,
    r_OD:  privateParams.r_OD,
    days:  shared.days,
    cash_floor: 0,
  };

  const result = useMemo(() => calcOptimalBuffer(params), [params]);
  const sensData = useMemo(() => genSensitivity(params, sensParam), [params, sensParam]);
  const multiCcy = useMemo(
    () => calcMultiCcyTable(params.P, params.σ_P, params.days, params.r_USD),
    [params.P, params.σ_P, params.days, params.r_USD]
  );

  const meta = SENS_META[sensParam];
  const currentX = sensParam === 'deltaR' ? result.delta_r
    : sensParam === 'sigmaP' ? params.σ_P
    : params.r_OD;

  return (
    <div className="flex gap-6">
      {/* ── LEFT PANEL: controls ── */}
      <div className="w-72 shrink-0 space-y-5">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Parameters</h3>

          <Slider
            label="Expected payouts (P, M FCY)"
            sublabel="Forecast payout before forward settles"
            value={params.P} min={0.5} max={100} step={0.5} unit="M"
            onChange={v => setPrivate('P', v)}
          />
          <Slider
            label="Forecast uncertainty (σ_P)"
            sublabel="Std dev of payout volume as fraction"
            value={params.σ_P} min={0} max={0.40} step={0.01} unit=""
            onChange={v => onSharedChange('σ_P', v)}
          />
          <Slider
            label="USD deposit rate (r_USD)"
            value={params.r_USD} min={0} max={8} step={0.05} unit="%"
            onChange={v => onSharedChange('r_USD', v)}
          />
          <Slider
            label="FCY deposit rate (r_FCY)"
            sublabel="Rate earned holding FCY cash"
            value={params.r_FCY} min={0} max={50} step={0.05} unit="%"
            onChange={v => setPrivate('r_FCY', v)}
          />
          <Slider
            label="Overdraft rate (r_OD)"
            sublabel="Cost of FCY account overdraft"
            value={params.r_OD} min={1} max={55} step={0.5} unit="%"
            onChange={v => setPrivate('r_OD', v)}
          />
          <Slider
            label="Settlement gap (days)"
            sublabel="Days between payout due and fwd settlement"
            value={params.days} min={1} max={30} step={1} unit="d"
            onChange={v => onSharedChange('days', v)}
          />
        </div>

        {/* Result card */}
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-blue-800">Optimal Buffer H*</h3>
            <CarryBadge dir={result.carry_direction} />
          </div>

          <div className="text-3xl font-bold text-blue-900">
            {fmt2(result.H_optimal)}
            <span className="ml-1 text-base font-normal text-blue-600">M FCY</span>
          </div>

          <div className="text-xs text-blue-700 font-medium">
            = {fmt1(result.H_pct_of_P)}% of expected payouts
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded bg-white/70 px-2 py-1.5">
              <div className="text-gray-500">Optimal P(shortfall)</div>
              <div className="font-semibold text-gray-900">{fmt1(result.shortfall_prob_pct)}%</div>
            </div>
            <div className="rounded bg-white/70 px-2 py-1.5">
              <div className="text-gray-500">Carry diff Δr</div>
              <div className={`font-semibold ${result.delta_r > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {result.delta_r > 0 ? '+' : ''}{fmt2(result.delta_r)}%
              </div>
            </div>
            <div className="rounded bg-white/70 px-2 py-1.5">
              <div className="text-gray-500">Hold cost/day</div>
              <div className="font-semibold text-gray-900">{result.C_hold_daily.toFixed(4)} M</div>
            </div>
            <div className="rounded bg-white/70 px-2 py-1.5">
              <div className="text-gray-500">OD cost/day</div>
              <div className="font-semibold text-gray-900">{result.C_OD_daily.toFixed(4)} M</div>
            </div>
          </div>

          <div className="rounded bg-white/70 px-2 py-1.5 text-xs">
            <div className="text-gray-500 mb-1">Cost breakdown (daily)</div>
            {result.TC_daily > 0 ? (
              <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-800 ring-1 ring-slate-700/80">
                <div
                  className="h-full bg-emerald-500/70"
                  style={{ width: `${(result.C_hold_daily / result.TC_daily * 100)}%` }}
                  title="Hold cost"
                />
                <div
                  className="h-full bg-amber-500/70"
                  style={{ width: `${(result.C_OD_daily / result.TC_daily * 100)}%` }}
                  title="OD cost"
                />
              </div>
            ) : <div className="text-gray-400">n/a</div>}
            <div className="flex gap-3 mt-1 text-gray-500">
              <span><span className="inline-block w-2 h-2 rounded-full bg-emerald-500/70 mr-1"/>Hold</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-amber-500/70 mr-1"/>Overdraft</span>
            </div>
          </div>

          <div className="text-xs text-blue-600 border-t border-blue-200 pt-2">
            H* = P × (1 + σ_P × Φ⁻¹(1 − Δr/r_OD))
          </div>
        </div>
      </div>

      {/* ── RIGHT PANEL: chart + table ── */}
      <div className="flex-1 space-y-5 min-w-0">
        {/* Sensitivity chart */}
        <div className="rounded-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700">Sensitivity Analysis — H* as % of expected payouts</h3>
            <div className="flex gap-1">
              {(Object.keys(SENS_META) as SensParam[]).map(k => (
                <button
                  key={k}
                  onClick={() => setSensParam(k)}
                  className={`px-3 py-1 text-xs rounded border transition-colors ${
                    sensParam === k
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {SENS_META[k].label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <LineChart
              series={sensData}
              xLabel={meta.xLabel}
              yLabel="H* as % of payouts (P)"
              xUnit={meta.xUnit}
              yUnit="%"
              xDecimals={meta.xDecimals}
              yDecimals={0}
              width={560}
              height={260}
              hRefLine={100}
              hRefLabel="100% = full payout"
            />
          </div>

          <div className="mt-2 text-xs text-gray-500">
            Current setting: {meta.xLabel.split(' ')[0]} = <strong>{currentX.toFixed(meta.xDecimals)}{meta.xUnit}</strong>
            {' '}→ H* = <strong>{fmt1(result.H_pct_of_P)}%</strong> of P
            {' · '}Optimal shortfall P = <strong>{fmt1(result.shortfall_prob_pct)}%</strong>
          </div>
        </div>

        {/* Multi-currency table */}
        <div className="rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            Multi-Currency Buffer Comparison
            <span className="ml-2 text-xs font-normal text-gray-400">
              (P={fmt2(params.P)}M · σ_P={fmt1(params.σ_P*100)}% · days={params.days} · r_USD={fmt2(params.r_USD)}%)
            </span>
          </h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b-2 border-gray-200">
                <th className="py-1 text-left font-semibold text-gray-600">CCY</th>
                <th className="py-1 text-right font-semibold text-gray-600">r_FCY %</th>
                <th className="py-1 text-right font-semibold text-gray-600">r_OD %</th>
                <th className="py-1 text-right font-semibold text-gray-600">Δr %</th>
                <th className="py-1 text-right font-semibold text-gray-600">H* (% of P)</th>
                <th className="py-1 text-right font-semibold text-gray-600">P(shortfall)</th>
                <th className="py-1 text-left font-semibold text-gray-600 pl-3">NWC carry</th>
                <th className="py-1 text-right font-semibold text-gray-600">H* (M FCY)</th>
              </tr>
            </thead>
            <tbody>
              {multiCcy.map(row => (
                <tr key={row.ccy} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-1 font-bold text-gray-900">{row.ccy}</td>
                  <td className="py-1 text-right text-gray-700">{fmt2(row.r_FCY)}</td>
                  <td className="py-1 text-right text-gray-500">{fmt2(row.r_OD)}</td>
                  <td className={`py-1 text-right font-medium ${row.delta_r > 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {row.delta_r > 0 ? '+' : ''}{fmt2(row.delta_r)}
                  </td>
                  <td className="py-1 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <DeskProgressTrack
                        pct={Math.min(100, row.H_pct / 1.6)}
                        className="w-20"
                      />
                      <span className="font-semibold text-gray-900 w-12 text-right">{fmt1(row.H_pct)}%</span>
                    </div>
                  </td>
                  <td className="py-1 text-right text-gray-600">{fmt1(row.shortfall_pct)}%</td>
                  <td className="py-1 pl-3"><CarryBadge dir={row.carry_dir} /></td>
                  <td className="py-1 text-right font-semibold text-gray-900">
                    {fmt2(params.P * row.H_pct / 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 text-xs text-gray-400 space-y-1">
            <p>
              <strong>EARN CARRY:</strong> r_FCY &gt; r_USD — holding more FCY is profitable; larger buffer is actively beneficial.
            </p>
            <p>
              <strong>PAY CARRY:</strong> r_FCY &lt; r_USD — holding FCY has an opportunity cost; optimal to hold less but enough to cover payout risk.
            </p>
            <p>
              H* = P × (1 + σ_P × Φ⁻¹(1 − Δr/r_OD)) · Δr = r_USD − r_FCY · Each row uses per-currency carry + overdraft rates.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
