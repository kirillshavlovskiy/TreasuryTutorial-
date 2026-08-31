'use client';

import { SimRow } from '@/lib/sim-types';
import { BandSummaryCard, DirectionalBar, MiniBar, StackedBar } from './BarVisualizations';

export function CompactBarsView({
  rows,
}: {
  rows: SimRow[];
}) {
  const maxTrough = Math.max(...rows.map(r => Math.abs(r.troughCash || 0)), 1);
  const maxTarget = Math.max(...rows.map(r => Math.abs(r.targetCash || 0)), 1);
  const maxSwap = Math.max(...rows.map(r => Math.abs(r.swapNear || 0)), 1);
  const maxFwd = Math.max(...rows.map(r => Math.abs(r.fwdHedgeUsd || 0)), 1);
  const maxCarry = Math.max(...rows.map(r => Math.abs((r.cashCarryUsdM || 0) + (r.bufferCarryUsdM || 0) + (r.hedgeCarryUsdM || 0))), 1);

  return (
    <div className="p-4 space-y-4">
      <div className="text-sm font-semibold text-gray-700">Compact Bars View — Core Metrics per Section</div>

      <div className="grid grid-cols-1 gap-4">
        {rows.map(r => (
          <div key={r.id} className="border border-gray-200 rounded-lg p-4 bg-white">
            {/* Currency header */}
            <div className="mb-4 pb-3 border-b border-gray-200">
              <span className="text-sm font-bold text-gray-900">{r.ccy}</span>
            </div>

            {/* 5-column band layout */}
            <div className="grid grid-cols-5 gap-4">
              {/* LIQUIDITY POOL BOOK */}
              <BandSummaryCard title="Liquidity Pool Book" bgColor="bg-sky-50" textColor="text-sky-700">
                <MiniBar
                  value={r.troughCash || 0}
                  max={maxTrough}
                  label="Trough Cash"
                  color="bg-sky-500"
                />
                <MiniBar
                  value={r.closeBalance || 0}
                  max={maxTrough}
                  label="Close Balance"
                  color="bg-sky-400"
                />
              </BandSummaryCard>

              {/* CARRY / BUFFER */}
              <BandSummaryCard title="Carry / Buffer" bgColor="bg-amber-50" textColor="text-amber-700">
                <MiniBar
                  value={r.targetCash || 0}
                  max={maxTarget}
                  label="Target LP Cash"
                  color="bg-amber-500"
                />
                <div className="text-[10px] text-gray-600">
                  Carry: <span className="font-mono font-semibold text-amber-700">{r.carryRate?.toFixed(2) || '0.00'}%</span>
                </div>
              </BandSummaryCard>

              {/* SWAP */}
              <BandSummaryCard title="Swap" bgColor="bg-emerald-50" textColor="text-emerald-700">
                <DirectionalBar
                  value={r.swapNear || 0}
                  label="Swap Near"
                  maxAbsolute={maxSwap}
                  buyColor="bg-emerald-500"
                  sellColor="bg-red-500"
                />
                <div className="text-[10px] text-gray-600">
                  Book: <span className="font-mono font-semibold text-emerald-700">{(r.swapBook || 0).toFixed(1)}M</span>
                </div>
              </BandSummaryCard>

              {/* FX HEDGE */}
              <BandSummaryCard title="FX Hedge" bgColor="bg-rose-50" textColor="text-rose-700">
                <DirectionalBar
                  value={r.fwdHedgeUsd || 0}
                  label="Fwd Hedge"
                  maxAbsolute={maxFwd}
                  buyColor="bg-rose-500"
                  sellColor="bg-pink-500"
                />
                <div className="text-[10px] text-gray-600">
                  Delta: <span className="font-mono font-semibold text-rose-700">{(r.hedgeDelta || 0).toFixed(2)}</span>
                </div>
              </BandSummaryCard>

              {/* CARRY */}
              <BandSummaryCard title="Carry" bgColor="bg-purple-50" textColor="text-purple-700">
                <StackedBar
                  segments={[
                    { value: r.cashCarryUsdM || 0, color: 'bg-purple-400', label: 'Cash' },
                    { value: r.bufferCarryUsdM || 0, color: 'bg-purple-500', label: 'Buffer' },
                    { value: r.hedgeCarryUsdM || 0, color: 'bg-purple-600', label: 'Hedge' },
                  ]}
                  height="h-8"
                  showTotal={true}
                />
              </BandSummaryCard>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
