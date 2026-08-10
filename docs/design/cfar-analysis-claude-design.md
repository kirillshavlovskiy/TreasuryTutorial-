# Design brief — CFaR analysis tab

**Refinement only** — same dark slate Analytics panel. No new theme, no screenshots required.

**Code:** `CfarAnalysisView.tsx` (rendered by `VarAnalyticsPanel` when `perspective === 'cfar'`) · `CfarDrawdownChart` · lib: `cfar-residual.ts` · `cfar-drawdown.ts`

---

## Entry

Analytics perspective rail → **CFaR** tab (next to Cash Carry). Tab headline stat = aggregate **Net CFaR** across currencies (`residualCfarClosedFormUsdM`).

---

## What CFaR measures

Critical cash absorption — the p(conf) worst *running* negative cumulative cash P&L over the hedging horizon, i.e. the peak funding you must have on hand, **net of carry**.

- **Hedged book** → simulate the residual `r(t)=e−H` of the hedge chosen in Cash Carry, in **mark-to-market** mode → collateral/funding that closes to ~0 at Tf → **interior peak between T0 and Tf** (like residual VaR).
- **Unhedged book** → **accrued** open path `Π(t)=∫₀ᵗ e·dS` → accumulates → peaks at **Tf**.
- Carry (from the Cash Carry pipeline) accrues linearly and is netted against the drawdown.

---

## Tab chapter order (target)

| # | Block | Component |
|---|--------|-----------|
| 1 | Summary | 4 metric cards — Net CFaR · Gross CFaR · Carry offset · Path VaR ref |
| 2 | Per-CCY table | Critical cash absorption per currency · click row selects chart · All-CCY totals |
| 3 | Drawdown fan | `CfarDrawdownChart` for selected CCY · CCY toggle chips · red readout band |

---

## Summary cards (chapter 1)

4-up grid. Semantic kit reused from the hedge-carry modal:

| Card | Color | Value | Sub |
|------|-------|-------|-----|
| Net CFaR · {conf}% | **red** (VaR) | `fmtK(net)` | peak cash to fund, net of carry |
| Gross CFaR | **amber** (breakeven) | `fmtK(gross)` | before carry offset |
| Carry offset | **emerald** (cover; rose if −) | `fmtSignedK` | earned by peak draw |
| Path VaR ref | **blue** (legs) | `fmtK(openPathVar)` | `z·S₀·σ·√∫e²` |

---

## Per-CCY table (chapter 2)

- `overflow-x-auto` · `table w-full min-w-[640px] text-left text-xs`
- Header: `border-b border-slate-800 text-slate-500`; column headers semantic-tinted (Gross amber · Carry emerald · Net CFaR red)
- Columns: **CCY · Stock → End · Gross CFaR · Carry · Net CFaR · Peak**
- CCY cell stacked: ticker + structure badge (`Strip · N` / `Bullet`) + `Hedged` (emerald) / `Open` (slate) sub-label — synced to live `prepared` / booked strip legs
- Rows selectable — `role="button"` · `tabIndex=0` · Enter/Space · `hover:bg-violet-500/10` · selected `bg-violet-500/10`
- Zero carry renders `—`
- `tfoot` **All CCY** totals row (`bg-slate-900/40`) when >1 CCY (undiversified sum)

---

## Drawdown fan (chapter 3)

- Section chrome: `rounded-lg border border-slate-700 bg-slate-950/40 p-3`
- Header: `font-mono text-[10px] uppercase tracking-[0.09em] text-slate-500` — `{CCY} · residual MTM | accrued cash drawdown`
- CCY toggle-group chips — active `bg-violet-500/25 text-violet-100` (matches row selection)
- Red readout band (`border-red-800/40 bg-red-950/20`): Net/Max CFaR + gross + peak month + mode (`residual r(t)=e−H · MTM` vs `open path · accrued`)
- `CfarDrawdownChart` — percentile fan · carry line · critical-cash floor · peak marker at argmin of net-p05 trough
- Residual overlay (violet, secondary axis): the signed residual r(t)=e−H, with a ● marker at its zero-crossing — the **post-hedge exposure flip** driven by the chosen forward maturity

---

## Locked style

Reuse **`docs/design/design-system-claude.md`**.

- Panel: `rounded-xl border border-slate-700 bg-slate-900`
- Section: `rounded-lg border border-slate-700 bg-slate-950 p-3`
- Cards: 4-up grid · `text-[9px]` labels · `font-mono text-sm` values
- Semantic: Net CFaR red · Gross amber · Carry emerald · Path VaR blue · CCY select violet

---

## Problems to fix / watch

1. Structure/`Hedged` badge must stay in sync with the live prepared/booked strip (same class of bug as the hedge-carry modal header chips)
2. Hedged peak should sit **between** T0 and Tf — verify MTM mode, not accrued, for hedged residuals
3. All-CCY total is undiversified — keep the caption honest
4. Keep MC light enough for interactive re-render (few thousand paths, fixed seed for stable charts)

---

## Prompt for Claude Design (paste)

```
Refine the “CFaR analysis” tab in a dark FX treasury Analytics panel.

RULES: Same slate/emerald/violet/amber/red semantic kit · dense 9–11px type · refinement only · no screenshots

WHAT IT MEASURES: critical cash absorption = p(conf) worst running negative cumulative
cash P&L net of carry. Hedged book → residual r(t)=e−H in mark-to-market (interior peak
between T0 and Tf). Unhedged → accrued open path (peaks at Tf).

CHAPTERS (top → bottom)
1. Summary cards: Net CFaR (red), Gross CFaR (amber), Carry offset (emerald), Path VaR ref (blue)
2. Per-CCY table: CCY (with Strip·N/Bullet + Hedged/Open badge) · Stock→End · Gross · Carry · Net CFaR · Peak;
   click row selects chart; All-CCY totals row; violet selection accent
3. Drawdown fan: CfarDrawdownChart for selected CCY; CCY toggle chips (violet active); red readout band

FIX: badge must match live prepared/booked strip legs; hedged peak must be interior (MTM, not accrued);
undiversified All-CCY caption.

OUTPUT: Chapter wire order · summary card layout · table columns · drawdown fan zones (fan, carry line, floor, peak marker)
```
