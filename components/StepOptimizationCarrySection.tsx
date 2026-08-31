'use client';

import { useState, useEffect } from 'react';
import type { SolutionPick } from '@/lib/test-mode/solution-pick';
import {
  CarryConstraintIndicator,
  CarryBreakdownPanel,
} from './CarryConstraintIndicator';
import {
  useCarryConstraintValidation,
  formatCarryConstraintStatus,
  isCriticalCarryViolation,
} from '@/lib/hooks/useCarryConstraintValidation';

interface StepOptimizationCarrySectionProps {
  solution?: SolutionPick | null;
  carryTargetUsdYrM?: number;
  onCarryTargetChange?: (target: number | undefined) => void;
  expandBreakdown?: boolean;
}

/**
 * Complete carry constraint section for step optimization view.
 * Integrates indicator, violation warnings, and per-currency breakdown.
 */
export function StepOptimizationCarrySection({
  solution,
  carryTargetUsdYrM,
  onCarryTargetChange,
  expandBreakdown = false,
}: StepOptimizationCarrySectionProps) {
  const [showBreakdown, setShowBreakdown] = useState(expandBreakdown);

  const constraintState = useCarryConstraintValidation({
    carryTargetUsdYrM,
    totalCarryUsdYr: solution?.point.totalCarryUsdYr,
    onCarryTargetChange,
  });

  // Auto-expand breakdown if constraint violated
  useEffect(() => {
    if (constraintState.isViolated) {
      setShowBreakdown(true);
    }
  }, [constraintState.isViolated]);

  if (!solution) {
    return (
      <div className="p-4 text-center text-gray-500">
        No solution selected
      </div>
    );
  }

  const totalCarry = solution.point.totalCarryUsdYr ?? 0;
  const isCritical = isCriticalCarryViolation(constraintState);

  return (
    <div className="space-y-3">
      {/* Main carry constraint indicator */}
      <CarryConstraintIndicator
        totalCarryUsdYr={totalCarry}
        targetCarryUsdYr={carryTargetUsdYrM}
        carryViolation={constraintState.carryViolation}
        label={`Total Carry (${formatCarryConstraintStatus(constraintState)})`}
        showDetails={constraintState.carryViolation > 0.01}
      />

      {/* Critical violation warning banner */}
      {isCritical && (
        <div className="px-4 py-3 bg-red-100 border-l-4 border-red-500 rounded">
          <div className="flex items-start gap-3">
            <span className="text-xl">⚠️</span>
            <div className="flex-1">
              <h4 className="font-semibold text-red-900">Critical Carry Constraint Violation</h4>
              <p className="text-sm text-red-800 mt-1">
                Current allocation exceeds target by {constraintState.carryViolation.toFixed(2)}$k
                ({constraintState.violationPct.toFixed(0)}%).
              </p>
              <p className="text-sm text-red-800 mt-1">
                Carry amounts below have been proportionally reduced to meet the constraint.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Carry target input with constraint feedback */}
      <div className={`p-3 rounded-lg border ${
        constraintState.isViolated
          ? 'bg-red-50 border-red-300'
          : 'bg-purple-50 border-purple-300'
      }`}>
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-gray-700">
            Max Carry Target
          </label>
          <span className={`text-xs font-mono ${
            constraintState.isViolated ? 'text-red-700' : 'text-purple-700'
          }`}>
            {carryTargetUsdYrM?.toFixed(1) ?? 'Not set'}$k
          </span>
        </div>
        {constraintState.isViolated && (
          <div className="mt-2 text-[10px] text-red-700 font-medium">
            ⚠️ {constraintState.carryViolation.toFixed(2)}$k over target ({constraintState.violationPct.toFixed(0)}%)
          </div>
        )}
      </div>

      {/* Carry breakdown panel — toggle or always show if violated */}
      {(showBreakdown || constraintState.isViolated) && (
        <div>
          <button
            onClick={() => setShowBreakdown(!showBreakdown)}
            className="text-xs font-semibold text-purple-700 hover:text-purple-900 mb-2 flex items-center gap-1"
          >
            {showBreakdown ? '▾' : '▸'} Per-Currency Breakdown
          </button>
          {showBreakdown && (
            <CarryBreakdownPanel
              totalCarryByCcy={solution.totalCarryByCcy}
              targetCarryUsdYr={carryTargetUsdYrM}
              carryViolation={constraintState.carryViolation}
              showClamped={true}
            />
          )}
        </div>
      )}

      {/* Solution metadata */}
      <div className="px-3 py-2 text-[10px] text-gray-600 space-y-1">
        <div>
          <span className="font-mono">Scenario:</span>
          <span className="ml-1">{solution.scenarioId}</span>
        </div>
        <div>
          <span className="font-mono">Portfolio VAR:</span>
          <span className="ml-1">{solution.point.portfolioVarUsd?.toFixed(1) ?? '—'}M</span>
        </div>
        <div>
          <span className="font-mono">Overlay scale (overlayT):</span>
          <span className="ml-1">{solution.overlayT.toFixed(3)}</span>
        </div>
        {constraintState.carryViolation > 0.01 && (
          <div className="text-red-600 font-mono">
            <span>Carry violation:</span>
            <span className="ml-1">{constraintState.carryViolation.toFixed(3)}$k</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Minimal carry status badge for table header/summary.
 */
export function CarryStatusBadge({
  totalCarryUsdYr,
  targetCarryUsdYrM,
  carryViolation = 0,
}: {
  totalCarryUsdYr?: number;
  targetCarryUsdYrM?: number;
  carryViolation?: number;
}) {
  const isViolated = carryViolation > 1e-6;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-mono ${
      isViolated
        ? 'bg-red-100 text-red-700 border border-red-300'
        : 'bg-purple-100 text-purple-700 border border-purple-300'
    }`}>
      {isViolated && <span>⚠️</span>}
      {totalCarryUsdYr?.toFixed(1) ?? '0'}$k
      {targetCarryUsdYrM != null && (
        <>
          <span className="text-gray-500">/</span>
          {targetCarryUsdYrM.toFixed(1)}$k
        </>
      )}
    </span>
  );
}
