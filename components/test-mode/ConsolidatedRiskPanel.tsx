'use client';

import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';

function fmtLocal(v: number, ccy: string): string {
  const abs = Math.abs(v).toFixed(2);
  const sign = v >= 0 ? '+' : '−';
  if (ccy === 'EUR') return `${sign}€${abs}M`;
  if (ccy === 'PLN') return `${sign}zł${abs}M`;
  if (ccy === 'USD') return `${sign}$${abs}M`;
  if (ccy === 'GBP') return `${sign}£${abs}M`;
  return `${sign}${abs}M ${ccy}`;
}

function fmtVarK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

interface ConsolidatedRiskPanelProps {
  rows: CurrencyRiskRow[];
  selectedCcy: string | null;
  onSelect: (ccy: string) => void;
}

/** Risk layer: 1M 95% VaR per currency on the consolidated group book. */
export function ConsolidatedRiskPanel({
  rows,
  selectedCcy,
  onSelect,
}: ConsolidatedRiskPanelProps) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="text-sm font-semibold text-white">Risk layer — VaR per currency</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        1-month 95% VaR on stock exposure (group net). Not the NP carry-overlay portfolio VAR.
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-xs">
          <thead>
            <tr className="border-b border-slate-700 text-slate-500">
              <th className="py-2 pr-3 font-medium">CCY</th>
              <th className="py-2 pr-3 font-medium">Dir</th>
              <th className="py-2 pr-3 font-medium">Stock net</th>
              <th className="py-2 pr-3 font-medium">3m avg</th>
              <th className="py-2 pr-3 font-medium">VaR (stock)</th>
              <th className="py-2 font-medium">VaR (3m avg)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ bar, varStock, varAvg3m }) => {
              const selected = selectedCcy === bar.ccy;
              return (
                <tr
                  key={bar.ccy}
                  onClick={() => onSelect(bar.ccy)}
                  className={`cursor-pointer border-b border-slate-800/80 ${
                    selected ? 'bg-emerald-500/10' : 'hover:bg-slate-800/50'
                  }`}
                >
                  <td className="py-2.5 pr-3 font-semibold text-slate-200">{bar.ccy}</td>
                  <td className="py-2.5 pr-3 text-slate-400">{bar.direction}</td>
                  <td
                    className={`py-2.5 pr-3 font-mono ${
                      bar.stockNetM >= 0 ? 'text-emerald-300' : 'text-rose-300'
                    }`}
                  >
                    {fmtLocal(bar.stockNetM, bar.ccy)}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-slate-400">
                    {fmtLocal(bar.avg3mM, bar.ccy)}
                  </td>
                  <td className="py-2.5 pr-3 font-mono font-semibold text-white">
                    {fmtVarK(varStock.varUsdM)}
                  </td>
                  <td className="py-2.5 font-mono text-slate-500">
                    {fmtVarK(varAvg3m.varUsdM)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
