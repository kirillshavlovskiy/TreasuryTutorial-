import { useEffect, useRef } from 'react';

interface CarryConstraintState {
  carryTargetUsdYrM?: number;
  totalCarryUsdYr?: number;
  carryViolation: number;
  isViolated: boolean;
  violationPct: number;
}

/**
 * Hook to track carry constraint violations and trigger updates when target changes.
 * Watches carryTargetUsdYrM and triggers a callback when it changes significantly.
 */
export function useCarryConstraintValidation({
  carryTargetUsdYrM,
  totalCarryUsdYr = 0,
  onCarryTargetChange,
}: {
  carryTargetUsdYrM?: number;
  totalCarryUsdYr?: number;
  onCarryTargetChange?: (target: number | undefined) => void;
}): CarryConstraintState {
  const prevTargetRef = useRef<number | undefined>(carryTargetUsdYrM);

  useEffect(() => {
    if (
      carryTargetUsdYrM !== prevTargetRef.current
      && Math.abs((carryTargetUsdYrM ?? 0) - (prevTargetRef.current ?? 0)) > 0.01
    ) {
      prevTargetRef.current = carryTargetUsdYrM;
      onCarryTargetChange?.(carryTargetUsdYrM);
    }
  }, [carryTargetUsdYrM, onCarryTargetChange]);

  const carryViolation = carryTargetUsdYrM != null && Number.isFinite(carryTargetUsdYrM)
    ? Math.max(0, (totalCarryUsdYr ?? 0) - carryTargetUsdYrM)
    : 0;

  const isViolated = carryViolation > 1e-6;
  const violationPct = carryTargetUsdYrM && carryTargetUsdYrM > 1e-9
    ? (carryViolation / carryTargetUsdYrM) * 100
    : 0;

  return {
    carryTargetUsdYrM,
    totalCarryUsdYr,
    carryViolation,
    isViolated,
    violationPct,
  };
}

/**
 * Formats carry constraint status for logging/display.
 */
export function formatCarryConstraintStatus(state: CarryConstraintState): string {
  if (!state.isViolated) {
    if (state.carryTargetUsdYrM != null && state.totalCarryUsdYr != null) {
      const utilization = (state.totalCarryUsdYr / state.carryTargetUsdYrM) * 100;
      return `${state.totalCarryUsdYr.toFixed(1)}$k / ${state.carryTargetUsdYrM.toFixed(1)}$k target (${utilization.toFixed(0)}%)`;
    }
    return `${state.totalCarryUsdYr?.toFixed(1) ?? '0'}$k`;
  }
  return `⚠️ VIOLATED: ${state.totalCarryUsdYr?.toFixed(1) ?? '0'}$k > ${state.carryTargetUsdYrM?.toFixed(1) ?? '?'}$k (excess: ${state.carryViolation.toFixed(1)}$k, ${state.violationPct.toFixed(0)}%)`;
}

/**
 * Detect if a carry constraint violation is critical (exceeds target by >5%).
 */
export function isCriticalCarryViolation(violation: CarryConstraintState): boolean {
  return violation.isViolated && violation.violationPct > 5;
}
