/**
 * One hedge structure on the risk/return plane.
 *
 * The risk coordinate is GROSS CFaR, not net. Net already has carry subtracted
 * from it, so pairing net with carry puts the same quantity on both axes and a
 * structure appears to buy risk reduction with carry it has just been credited
 * for on the other axis. Gross is measured with interest accrual off and is
 * untouched by the carry schedule, so the two coordinates are independent and
 * the trade-off between them is real.
 *
 * Net is carried alongside because it remains the decision criterion, and on
 * these axes it is a diagonal: net = gross − carry, so equal-reserve lines run
 * at 45° and the best structure is the one the lowest such line touches.
 */
export interface FrontierPoint {
  /**
   * Cover as a fraction of the applied notional — 1 is the hedge as dealt.
   *
   * Cover is the dial, not leg count. Leg count cannot draw a frontier on a
   * book like this: settling earlier both closes the mismatch and converts
   * into the higher-yielding currency sooner, so more legs win on risk AND on
   * carry and every other structure is dominated. Cover genuinely trades one
   * against the other, because risk is U-shaped in it — falling to a minimum
   * around full cover, then rising again as an over-hedge becomes an exposure
   * of its own, while carry keeps climbing with notional.
   */
  coverRatio: number;
  grossCfarUsdM: number;
  netCfarUsdM: number;
  carryUsdM: number;
}

/**
 * The structures that are actually efficient: no other sampled structure
 * offers at least as much carry for no more gross CFaR.
 *
 * Sweeping from the richest carry downwards, a point survives only if it beats
 * every richer point on risk — the standard skyline, one sort. Without it the
 * chart is a parametric trace rather than a frontier: it joins every sample in
 * sweep order and draws dominated structures as though they were choices worth
 * making. On a currency that earns carry the whole under-hedged branch is
 * dominated, since covering more buys less risk and more carry at once, and
 * only the over-hedged branch survives; on one that pays carry it is the other
 * way round. Either way the answer falls out of the same sweep.
 *
 * Returned in ascending carry order so a line through the result cannot double
 * back on itself.
 */
export function efficientFrontier(
  points: readonly FrontierPoint[],
): FrontierPoint[] {
  const byCarryDesc = [...points].sort(
    (a, b) => b.carryUsdM - a.carryUsdM || a.grossCfarUsdM - b.grossCfarUsdM,
  );
  const keep: FrontierPoint[] = [];
  let bestGross = Number.POSITIVE_INFINITY;
  for (const p of byCarryDesc) {
    if (p.grossCfarUsdM < bestGross - 1e-9) {
      keep.push(p);
      bestGross = p.grossCfarUsdM;
    }
  }
  return keep.reverse();
}

/**
 * Whether there is really a trade-off to walk, or whether one structure simply
 * wins. Two things collapse the frontier: only one survivor, or survivors
 * spanning so little risk that the "curve" is a flat line the sweep's own
 * Monte Carlo error could have drawn.
 *
 * The second case is not hypothetical. A bullet book barely responds to cover
 * at all — the single settlement lands at maturity, after the drawdown has
 * already peaked — so risk moves by a fraction of a percent across the whole
 * sweep and whichever point the sampling happens to favour is left looking
 * efficient. Drawing that as a frontier invites the desk to read a slope that
 * is noise.
 */
export function isDegenerateFrontier(
  all: readonly FrontierPoint[],
  efficient: readonly FrontierPoint[],
): boolean {
  if (efficient.length < 2) return true;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const p of all) {
    if (p.grossCfarUsdM < lo) lo = p.grossCfarUsdM;
    if (p.grossCfarUsdM > hi) hi = p.grossCfarUsdM;
  }
  const span = hi - lo;
  if (span <= 1e-9) return true;
  // Measured against the LEVEL of risk, not against the sweep's own span,
  // which is circular: on a flat book the surviving points span most of a
  // range that is itself a rounding error, and the frontier looks healthy by
  // exactly the measure that should have caught it.
  const scale = Math.max(Math.abs(hi), Math.abs(lo));
  return scale > 1e-9 && span / scale < 0.05;
}

/** Lowest reserve on the frontier — the tangency with the 45° net iso-line. */
export function lowestReservePoint(
  frontier: readonly FrontierPoint[],
): FrontierPoint | null {
  return frontier.reduce<FrontierPoint | null>(
    (best, p) => (best == null || p.netCfarUsdM < best.netCfarUsdM ? p : best),
    null,
  );
}
