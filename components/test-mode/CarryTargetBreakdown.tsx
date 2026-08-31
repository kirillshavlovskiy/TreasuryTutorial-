'use client';

function fmtSignedK(usdM: number): string {
  if (!Number.isFinite(usdM)) return '—';
  const k = usdM * 1000;
  if (Math.abs(k) < 0.5) return '$0K';
  return `${k >= 0 ? '' : '−'}$${Math.abs(k).toFixed(0)}K`;
}

function fmtAbsK(usdM: number): string {
  if (!Number.isFinite(usdM)) return '—';
  const k = Math.abs(usdM) * 1000;
  if (k < 0.5) return '$0K';
  return `$${k.toFixed(0)}K`;
}

export interface CarryBreakdownRow {
  ccy: string;
  positionType: 'long EARN' | 'short PAY' | 'hold';
  mixW?: number; // Mix weight %
  cashCarryK?: number;
  hedgeCarryK?: number;
  overlayCarryK?: number;
  swapCashCarryK?: number;
  cipCarryK?: number;
  totalCarryK?: number;
  portCfarK?: number;
  notionalM?: number;
  overlayFcyM?: number;
  stripSchedule?: string;
  swapNearM?: number;
  swapFarM?: number;
  swapBookM?: number;
  stripW?: number;
}

export function CarryTargetBreakdown({
  rows,
  totalCarryK,
}: {
  rows: CarryBreakdownRow[];
  totalCarryK?: number;
}) {
  if (!rows || rows.length === 0) return null;

  const totals = rows.reduce(
    (acc, row) => ({
      mixW: (acc.mixW ?? 0) + (row.mixW ?? 0),
      cashCarryK: (acc.cashCarryK ?? 0) + (row.cashCarryK ?? 0),
      hedgeCarryK: (acc.hedgeCarryK ?? 0) + (row.hedgeCarryK ?? 0),
      overlayCarryK: (acc.overlayCarryK ?? 0) + (row.overlayCarryK ?? 0),
      swapCashCarryK: (acc.swapCashCarryK ?? 0) + (row.swapCashCarryK ?? 0),
      cipCarryK: (acc.cipCarryK ?? 0) + (row.cipCarryK ?? 0),
      totalCarryK: (acc.totalCarryK ?? 0) + (row.totalCarryK ?? 0),
      portCfarK: (acc.portCfarK ?? 0) + (row.portCfarK ?? 0),
      notionalM: (acc.notionalM ?? 0) + (row.notionalM ?? 0),
      overlayFcyM: (acc.overlayFcyM ?? 0) + (row.overlayFcyM ?? 0),
      swapBookM: (acc.swapBookM ?? 0) + (row.swapBookM ?? 0),
    }),
    {} as Record<string, number>,
  );

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">Carry Target {fmtSignedK(totalCarryK ?? 0)} - Breakdown by Currency</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1400px] text-left font-mono text-[11px]">
          <thead>
            <tr className="border-b border-slate-700 text-slate-400">
              <th className="px-2 py-1.5">CCY</th>
              <th className="px-2 py-1.5">Position</th>
              <th className="px-2 py-1.5">Mix w%</th>
              <th className="px-2 py-1.5">Cash</th>
              <th className="px-2 py-1.5">Hedge</th>
              <th className="px-2 py-1.5">Overlay</th>
              <th className="px-2 py-1.5">Swap Cash</th>
              <th className="px-2 py-1.5">CIP</th>
              <th className="px-2 py-1.5 font-semibold">Total Carry</th>
              <th className="px-2 py-1.5">Port. CFaR</th>
              <th className="px-2 py-1.5">Notional $</th>
              <th className="px-2 py-1.5">Overlay FCY</th>
              <th className="px-2 py-1.5">Strip</th>
              <th className="px-2 py-1.5">Swap Near</th>
              <th className="px-2 py-1.5">Swap Book</th>
              <th className="px-2 py-1.5">Strip w%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx} className="border-b border-slate-800 hover:bg-slate-900/30">
                <td className="px-2 py-1 font-semibold text-sky-400">{row.ccy}</td>
                <td className="px-2 py-1 text-slate-400">{row.positionType}</td>
                <td className="px-2 py-1 text-right">{row.mixW != null ? `${(row.mixW * 100).toFixed(0)}%` : '—'}</td>
                <td className="px-2 py-1 text-right">{row.cashCarryK != null ? fmtSignedK(row.cashCarryK) : '—'}</td>
                <td className="px-2 py-1 text-right">{row.hedgeCarryK != null ? fmtSignedK(row.hedgeCarryK) : '—'}</td>
                <td className="px-2 py-1 text-right">{row.overlayCarryK != null ? fmtSignedK(row.overlayCarryK) : '—'}</td>
                <td className="px-2 py-1 text-right">{row.swapCashCarryK != null ? fmtSignedK(row.swapCashCarryK) : '—'}</td>
                <td className="px-2 py-1 text-right">{row.cipCarryK != null ? fmtSignedK(row.cipCarryK) : '—'}</td>
                <td className={`px-2 py-1 text-right font-semibold ${row.totalCarryK != null && row.totalCarryK > 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {row.totalCarryK != null ? fmtSignedK(row.totalCarryK) : '—'}
                </td>
                <td className="px-2 py-1 text-right">{row.portCfarK != null ? fmtAbsK(row.portCfarK) : '—'}</td>
                <td className="px-2 py-1 text-right">{row.notionalM != null ? `${(row.notionalM / 1).toFixed(2)}M` : '—'}</td>
                <td className="px-2 py-1 text-right">{row.overlayFcyM != null ? `${(row.overlayFcyM / 1).toFixed(2)}M` : '—'}</td>
                <td className="px-2 py-1 text-center text-slate-400">{row.stripSchedule ?? '—'}</td>
                <td className="px-2 py-1 text-right">{row.swapNearM != null ? `${(row.swapNearM / 1).toFixed(2)}M` : '—'}</td>
                <td className="px-2 py-1 text-right">{row.swapFarM != null ? `${(row.swapFarM / 1).toFixed(2)}M` : '—'}</td>
                <td className="px-2 py-1 text-right">{row.stripW != null ? `${(row.stripW * 100).toFixed(0)}%` : '—'}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-slate-600 bg-slate-900/50 font-semibold">
              <td colSpan={2} className="px-2 py-1.5">Σ Total</td>
              <td className="px-2 py-1.5 text-right">{totals.mixW?.toFixed(0)}%</td>
              <td className="px-2 py-1.5 text-right">{fmtSignedK(totals.cashCarryK ?? 0)}</td>
              <td className="px-2 py-1.5 text-right">{fmtSignedK(totals.hedgeCarryK ?? 0)}</td>
              <td className="px-2 py-1.5 text-right">{fmtSignedK(totals.overlayCarryK ?? 0)}</td>
              <td className="px-2 py-1.5 text-right">{fmtSignedK(totals.swapCashCarryK ?? 0)}</td>
              <td className="px-2 py-1.5 text-right">{fmtSignedK(totals.cipCarryK ?? 0)}</td>
              <td className="px-2 py-1.5 text-right text-yellow-400">{fmtSignedK(totalCarryK ?? 0)}</td>
              <td className="px-2 py-1.5 text-right">{fmtAbsK(totals.portCfarK ?? 0)}</td>
              <td className="px-2 py-1.5 text-right">{(totals.notionalM / 1).toFixed(2)}M</td>
              <td className="px-2 py-1.5 text-right">{(totals.overlayFcyM / 1).toFixed(2)}M</td>
              <td colSpan={3} className="px-2 py-1.5" />
              <td className="px-2 py-1.5 text-right">{(totals.swapBookM / 1).toFixed(2)}M</td>
              <td className="px-2 py-1.5 text-right">100%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-slate-500">
        ⚠ Check: Short EUR shows +$1411K carry but notional is only -5.25M. Verify carry signs match position direction.
      </p>
    </div>
  );
}
