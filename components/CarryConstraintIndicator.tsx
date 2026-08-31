'use client';

import { ReactNode } from 'react';

interface CarryConstraintIndicatorProps {
  totalCarryUsdYr: number;
  targetCarryUsdYr?: number;
  carryViolation?: number;
  label?: string;
  showDetails?: boolean;
}

export function CarryConstraintIndicator({
  totalCarryUsdYr,
  targetCarryUsdYr,
  carryViolation = 0,
  label = 'Total Carry',
  showDetails = false,
}: CarryConstraintIndicatorProps) {
  const isViolated = carryViolation > 1e-6;
  const violationPct = targetCarryUsdYr && targetCarryUsdYr > 1e-9
    ? (carryViolation / targetCarryUsdYr) * 100
    : 0;

  return (
    <div className={`px-3 py-2 rounded-lg border ${
      isViolated
        ? 'bg-red-50 border-red-400 text-red-900'
        : 'bg-purple-50 border-purple-300 text-purple-900'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isViolated && (
            <span className="inline-flex items-center justify-center w-5 h-5 bg-red-500 text-white rounded-full text-xs font-bold">
              !
            </span>
          )}
          <span className="text-xs font-medium">{label}</span>
        </div>
        <span className="font-mono font-semibold">
          {totalCarryUsdYr.toFixed(1)}$k
          {targetCarryUsdYr != null && (
            <span className={`ml-1 ${isViolated ? 'text-red-600' : 'text-purple-600'}`}>
              / {targetCarryUsdYr.toFixed(1)}$k
            </span>
          )}
        </span>
      </div>

      {isViolated && (
        <div className="mt-1.5 text-[10px] text-red-700">
          <div className="flex items-center gap-1">
            <span className="font-semibold">Constraint violated:</span>
            <span>
              exceeds by {carryViolation.toFixed(1)}$k ({violationPct.toFixed(0)}%)
            </span>
          </div>
          {showDetails && (
            <div className="mt-1 p-1.5 bg-red-100 rounded text-[9px]">
              <div>Carry is being proportionally reduced to meet target.</div>
            </div>
          )}
        </div>
      )}

      {!isViolated && targetCarryUsdYr != null && (
        <div className="mt-1 text-[10px] text-purple-600">
          <span>{((totalCarryUsdYr / targetCarryUsdYr) * 100).toFixed(0)}% of target</span>
        </div>
      )}
    </div>
  );
}

interface PerCurrencyCarryRowProps {
  ccy: string;
  carry: number;
  targetCarryUsdYr?: number;
  totalCarryUsdYr?: number;
  carryViolation?: number;
}

export function PerCurrencyCarryRow({
  ccy,
  carry,
  targetCarryUsdYr,
  totalCarryUsdYr = 0,
  carryViolation = 0,
}: PerCurrencyCarryRowProps) {
  const isViolated = carryViolation > 1e-6;
  const pct = totalCarryUsdYr > 1e-9 ? (Math.abs(carry) / totalCarryUsdYr) * 100 : 0;

  return (
    <div className={`flex items-center justify-between px-2 py-1.5 rounded text-xs ${
      isViolated
        ? 'bg-red-50 border-l-2 border-red-400'
        : 'bg-white border-l-2 border-purple-300'
    }`}>
      <span className="font-mono font-semibold text-gray-700">{ccy}</span>
      <div className="flex items-center gap-2">
        <div className="flex-1 w-24 h-4 bg-gray-100 rounded overflow-hidden">
          <div
            className={`h-full ${carry >= 0 ? 'bg-purple-500' : 'bg-orange-500'}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
        <span className="font-mono text-right w-20">
          {carry >= 0 ? '+' : ''}{carry.toFixed(2)}$k
        </span>
      </div>
      {isViolated && (
        <span className="ml-2 text-[9px] text-red-600 font-semibold">
          ⚠️ clamped
        </span>
      )}
    </div>
  );
}

interface CarryBreakdownProps {
  totalCarryByCcy: Record<string, number>;
  targetCarryUsdYr?: number;
  carryViolation?: number;
  showClamped?: boolean;
}

export function CarryBreakdownPanel({
  totalCarryByCcy,
  targetCarryUsdYr,
  carryViolation = 0,
  showClamped = false,
}: CarryBreakdownProps) {
  const total = Object.values(totalCarryByCcy).reduce((s, v) => s + v, 0);
  const isViolated = carryViolation > 1e-6;
  const currencies = Object.entries(totalCarryByCcy)
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a));

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${
      isViolated
        ? 'bg-red-50 border-red-300'
        : 'bg-purple-50 border-purple-300'
    }`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className={`text-xs font-bold uppercase tracking-wide ${
          isViolated ? 'text-red-700' : 'text-purple-700'
        }`}>
          Carry Breakdown
        </h3>
        <span className="text-xs font-mono font-semibold text-gray-700">
          {total.toFixed(1)}$k {targetCarryUsdYr != null && `/ ${targetCarryUsdYr.toFixed(1)}$k`}
        </span>
      </div>

      {isViolated && showClamped && (
        <div className="px-2 py-1.5 bg-red-100 border border-red-300 rounded text-[10px] text-red-700">
          <div className="font-semibold mb-1">⚠️ Carry Constraint Violated</div>
          <div>Exceeds target by {carryViolation.toFixed(2)}$k. Values below are clamped.</div>
        </div>
      )}

      <div className="space-y-1.5">
        {currencies.map(([ccy, carry]) => (
          <PerCurrencyCarryRow
            key={ccy}
            ccy={ccy}
            carry={carry}
            totalCarryUsdYr={total}
            targetCarryUsdYr={targetCarryUsdYr}
            carryViolation={isViolated ? carryViolation : 0}
          />
        ))}
      </div>

      {total > 0 && targetCarryUsdYr != null && !isViolated && (
        <div className="mt-2 pt-2 border-t border-purple-200 text-[10px] text-purple-600">
          Utilization: {((total / targetCarryUsdYr) * 100).toFixed(0)}% of {targetCarryUsdYr.toFixed(1)}$k target
        </div>
      )}
    </div>
  );
}
