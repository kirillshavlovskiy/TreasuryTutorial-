# Design brief — Hedge carry profile modal

**Refinement only** — same dark slate modal. No new theme, no screenshots required.

**Code:** `CashCarryAnalyticsView.tsx` (`profileOpen` portal) · `SettleWamDeltaVsBookChart` · `ExposureHedgePathChart` (performance host)

---

## Entry

Hedging summary row → `{CCY} — hedge carry profile` · max-w-5xl · 90vh scroll · backdrop close

---

## Modal chapter order (target)

| # | Block | Component |
|---|--------|-----------|
| 1 | Summary | 4 metric cards — Cover · Legs · Resid VaR · Breakeven |
| 2 | Settle WAM | `SettleWamDeltaVsBookChart` + ladder table · click Mm selects WAM |
| 3 | Optimal strip | Shape search — see `shape-search-optimal-strip-claude-design.md` |
| 4 | Performance | Portaled tick-trades from `ExposureHedgePathChart` |
| 5 | Hedge path | Resid VaR + Exposure charts · gear (structure / schedule / CoM) |

---

## Header (fix stale chips)

- Title: `{CCY} — hedge carry profile`
- Meta chips must match **live** prepared package:
  - Structure: `Strip · N` or `Bullet`
  - Schedule: e.g. `M4/M6/M8/M12` (not stale single `M7`)
  - Skew: Front / Back / Neutral
  - Book WAM + Enhancement vs book

**Known bug:** chips can disagree with tick table leg count — sync with `prepared` / path strip state.

---

## Settle WAM chart (chapter 2)

- **View toggle:** Enhancement (default) · Strip execution (exact Δ + settle timing)
- Step 1: static **bullet** Enhancement curve — click month pins WAM without reshaping
- After **Apply shape:** shaped ladder; optional per-leg bars above M1–M12 (green accrued + sky enhancement)
- Table below chart: Mm · Δ · Enhancement · vs book · schedule

---

## Locked style

- Panel: `rounded-xl border border-slate-700 bg-slate-900`
- Section: `rounded-lg border border-slate-700 bg-slate-950 p-3`
- Cards: 4-up grid · `text-[9px]` labels · `font-mono text-sm` values
- Semantic: Cover emerald · Legs blue · VaR red · Breakeven amber · WAM emerald · Schedule amber/violet

---

## Problems to fix

1. Header chips out of sync with prepared strip
2. Chapter order / scroll hunting — summary → WAM → shape before deep path charts
3. Crowded performance + path blocks — clearer section breaks
4. Settle WAM chart: per-leg bars + execution view need clearer legend

---

## Prompt for Claude Design (paste)

```
Refine “{CCY} — hedge carry profile” modal in a dark FX treasury app.

RULES: Same slate/emerald/violet/amber semantic kit · dense 9–11px type · refinement only · no screenshots

CHAPTERS (top → bottom)
1. Summary cards: Cover, Legs, Resid VaR, Breakeven
2. Settle WAM: Enhancement curve + ladder table; toggle to Strip execution view; per-leg carry bars on chart
3. Optimal strip @ WAM (shape search block)
4. Performance tick-trades (portaled)
5. Hedge path charts + gear

FIX: Header Structure/Schedule/Skew chips must match live strip legs; reduce scroll hunting; stronger section hierarchy.

OUTPUT: Chapter wire order · header chip layout · Settle WAM chart zones (curve, leg bars, axis, table)
```
