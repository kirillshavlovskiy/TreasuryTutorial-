# Liquidity book vs funding swap

> Maintained by: all team members
> Hard dashboard invariant. Do not mix these books.

## Rule

**Never feed the funding swap into the LIQUIDITY POOL BOOK on the dashboard.**

The liquidity book is the operating cash path. The funding swap is a separate instrument. They must not share cells, openings, troughs, or closes.

## Where numbers live

| Number | Band | Source |
|--------|------|--------|
| Open / payins / payouts / cycle net / drawdown / trough / close | LIQUIDITY POOL BOOK | Unfunded ladder `liquidityCycles` (`buildLiquidityLadder`) |
| Target LP Cash | CARRY / BUFFER | H* / `post_swap_cash` |
| Swap Near, Swap Book, LP+Swap, Cycle End | SWAP | `liquidityPlan` (`swap_needed`, `standing_swap`, funded close) |
| Fwd / option / residual | FX HEDGE | Strategy hedge. Swap Near may be in the **hedge basis**. Never in the liquidity book. |

## Forbidden

- `liquidityPlan[k].opening_cash` in a liquidity-book cell (it already contains earlier Swap Near).
- `cycle_end_cash - this cycle's swap` as liquidity close when prior swaps are still in the opening.
- Writing table Fwd/Option (sized off Swap Near) back into `hedgeSettle` / the cash path.
- Adding `swapNear` to `lp_peak_cash`, `cash_after_payins`, or ladder `opening` / `closing` / `low`.

## Allowed

- FX hedge **settlement** (booked/staged delivery) on the operating path — that is cash, not the funding swap.
- Funded chain inside `fundedPlanFor` / `liquidityPlan` for **SWAP** and buffer sizing only.
- Swap Near in FX HEDGE residual (`forecastFx + swapNear`).

## Code

- Display helper: `liquidityBookCycle` in `components/UnifiedSimulator.tsx`
- Unfunded path: `lib/liquidity-ladder.ts`
- Funded path: `projectLiquidityCycles` / `fundedPlanFor` — SWAP band only on the table
