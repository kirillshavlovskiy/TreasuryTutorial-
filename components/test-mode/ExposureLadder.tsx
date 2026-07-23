'use client';

import type { LadderBar } from '@/lib/test-mode';

interface ExposureLadderProps {
  bars: LadderBar[];
  selectedCcy: string | null;
  onSelect: (ccy: string) => void;
  showAvg3m: boolean;
  onToggleAvg3m: (v: boolean) => void;
}

function fmtLocal(v: number, ccy: string): string {
  const abs = Math.abs(v).toFixed(1);
  const sign = v >= 0 ? '+' : '−';
  if (ccy === 'EUR') return `${sign}€${abs}M`;
  if (ccy === 'PLN') return `${sign}zł${abs}M`;
  if (ccy === 'USD') return `${sign}$${abs}M`;
  if (ccy === 'GBP') return `${sign}£${abs}M`;
  return `${sign}${abs}M ${ccy}`;
}

export function ExposureLadder({
  bars,
  selectedCcy,
  onSelect,
  showAvg3m,
  onToggleAvg3m,
}: ExposureLadderProps) {
  const maxAbs = Math.max(
    0.1,
    ...bars.map(b => Math.abs(showAvg3m ? b.avg3mM : b.stockNetM)),
  );

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Unified exposure ladder</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Group net · all entities · zero-anchored · local CCY millions
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={showAvg3m}
            onChange={e => onToggleAvg3m(e.target.checked)}
            className="rounded border-slate-600"
          />
          Show 3-month average layer
        </label>
      </div>

      <div className="mt-6 space-y-3">
        {/* Zero line label */}
        <div className="relative h-px bg-slate-600">
          <span className="absolute -top-2 left-1/2 -translate-x-1/2 bg-slate-900 px-2 text-[10px] text-slate-500">
            0
          </span>
        </div>

        {bars.map(bar => {
          const value = showAvg3m ? bar.avg3mM : bar.stockNetM;
          const pct = (Math.abs(value) / maxAbs) * 50;
          const isLong = value >= 0;
          const selected = selectedCcy === bar.ccy;
          return (
            <button
              key={bar.ccy}
              type="button"
              onClick={() => onSelect(bar.ccy)}
              className={`grid w-full grid-cols-[72px_1fr_100px] items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
                selected ? 'bg-emerald-500/10 ring-1 ring-emerald-500/40' : 'hover:bg-slate-800/80'
              }`}
            >
              <span className="text-xs font-semibold text-slate-300">
                {bar.ccy}
                {bar.direction === 'hub' && (
                  <span className="ml-1 text-[10px] font-normal text-slate-500">hub</span>
                )}
              </span>
              <div className="relative h-7">
                <div className="absolute inset-y-0 left-1/2 w-px bg-slate-600" />
                <div
                  className={`absolute top-1 h-5 rounded-sm ${
                    isLong ? 'left-1/2 bg-emerald-500/80' : 'right-1/2 bg-rose-500/80'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span
                className={`text-right text-xs font-mono font-medium ${
                  isLong ? 'text-emerald-300' : 'text-rose-300'
                }`}
              >
                {fmtLocal(value, bar.ccy)}
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
        Stock mismatch layers only (episode definition): EUR = Frankfurt cash + EU receivables;
        PLN = payroll accrual. Venture debt and GBP stake are on the books but excluded from this
        ladder. Click a currency to open VaR.
      </p>
    </div>
  );
}
