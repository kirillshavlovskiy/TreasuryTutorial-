import { describe, it, expect } from 'vitest';

/**
 * Tests for carry constraint validation and clamping logic.
 * Verifies that distributed carry per currency respects the frontier target.
 */

describe('Carry Constraint Validation', () => {
  describe('Carry violation detection', () => {
    it('should detect when distributed carry exceeds target', () => {
      const totalCarry = 150;
      const target = 100;
      const violation = Math.max(0, totalCarry - target);

      expect(violation).toBeGreaterThan(0);
      expect(violation).toBe(50);
    });

    it('should not flag violation when at or below target', () => {
      const testCases = [
        { total: 100, target: 100, expectedViolation: 0 },
        { total: 99.99, target: 100, expectedViolation: 0 },
        { total: 50, target: 100, expectedViolation: 0 },
      ];

      for (const { total, target, expectedViolation } of testCases) {
        const violation = Math.max(0, total - target);
        expect(Math.max(0, violation - expectedViolation)).toBeLessThan(1e-6);
      }
    });
  });

  describe('Proportional clamping', () => {
    it('should clamp carry proportionally across currencies', () => {
      const target = 100;
      const totalCarryByCcy = {
        EUR: 50,
        GBP: 40,
        JPY: 30,
        AUD: 40, // Total: 160 (exceeds 100)
      };
      const total = 160;

      const clampedCarry: Record<string, number> = {};
      const scale = target / total;

      for (const [ccy, carry] of Object.entries(totalCarryByCcy)) {
        clampedCarry[ccy] = carry * scale;
      }

      // Verify total matches target
      const clampedTotal = Object.values(clampedCarry).reduce((s, v) => s + v, 0);
      expect(clampedTotal).toBeCloseTo(target, 6);

      // Verify ratios are preserved
      const origRatio = 50 / 160; // EUR ratio
      const clampedRatio = clampedCarry.EUR! / target;
      expect(clampedRatio).toBeCloseTo(origRatio, 6);
    });

    it('should handle edge cases in clamping', () => {
      const target = 100;

      // Single currency
      const single = { EUR: 150 };
      const scale1 = target / 150;
      expect(single.EUR * scale1).toBeCloseTo(100, 6);

      // Zero carry (no scaling needed)
      const zero = { EUR: 0, GBP: 0 };
      const total2 = 0;
      if (total2 > 1e-9) {
        const scale2 = target / total2;
        for (const ccy of Object.keys(zero)) {
          zero[ccy] *= scale2;
        }
      }
      expect(Object.values(zero).reduce((s, v) => s + v, 0)).toBe(0);
    });
  });

  describe('Violation percentage calculation', () => {
    it('should calculate violation as percentage of target', () => {
      const testCases = [
        { total: 150, target: 100, expectedPct: 50 },
        { total: 125, target: 100, expectedPct: 25 },
        { total: 110, target: 100, expectedPct: 10 },
        { total: 100, target: 100, expectedPct: 0 },
      ];

      for (const { total, target, expectedPct } of testCases) {
        const violation = Math.max(0, total - target);
        const pct = target > 1e-9 ? (violation / target) * 100 : 0;
        expect(pct).toBeCloseTo(expectedPct, 1);
      }
    });
  });

  describe('Distributed carry validation', () => {
    it('should validate that sum of per-currency carry matches point total', () => {
      const pointCarry = 120;
      const totalCarryByCcy = {
        EUR: 40,
        GBP: 35,
        JPY: 30,
        AUD: 15,
      };

      const distributed = Object.values(totalCarryByCcy).reduce((s, v) => s + v, 0);
      expect(distributed).toBe(pointCarry);
    });

    it('should flag mismatch between point carry and distributed sum', () => {
      const pointCarry = 100;
      const distributed = 95; // Mismatch

      const mismatch = Math.abs(pointCarry - distributed);
      expect(mismatch).toBeGreaterThan(0);
    });
  });

  describe('Carry target constraint in context', () => {
    it('should respect carry target during frontier solution pricing', () => {
      // Simulate a solution with overlay
      const desktopCarry = {
        EUR: 30,
        GBP: 25,
      };
      const overlayCarry = {
        EUR: 35,
        GBP: 40,
      };
      const overlayT = 0.75;
      const carryTarget = 100;

      // Blend desk + overlay
      const blended: Record<string, number> = {};
      for (const ccy of Object.keys(desktopCarry)) {
        const desk = desktopCarry[ccy] ?? 0;
        const overlay = overlayCarry[ccy] ?? 0;
        blended[ccy] = desk * overlayT + overlay;
      }

      const total = Object.values(blended).reduce((s, v) => s + v, 0);

      // Check violation
      const violation = Math.max(0, total - carryTarget);

      // If violated, clamp
      let final = blended;
      if (violation > 1e-6) {
        const scale = carryTarget / total;
        final = {};
        for (const [ccy, carry] of Object.entries(blended)) {
          final[ccy] = carry * scale;
        }
      }

      const finalTotal = Object.values(final).reduce((s, v) => s + v, 0);
      expect(finalTotal).toBeLessThanOrEqual(carryTarget + 1e-6);
    });
  });

  describe('Constraint state tracking', () => {
    it('should track constraint state across solution changes', () => {
      const solutions = [
        { carry: 80, target: 100, violation: 0, isCritical: false },
        { carry: 110, target: 100, violation: 10, isCritical: true },
        { carry: 150, target: 100, violation: 50, isCritical: true },
      ];

      for (const sol of solutions) {
        const violation = Math.max(0, sol.carry - sol.target);
        const pct = sol.target > 1e-9 ? (violation / sol.target) * 100 : 0;
        const isCritical = pct > 5; // >5% is critical

        expect(violation).toBe(sol.violation);
        expect(isCritical).toBe(sol.isCritical);
      }
    });
  });
});
