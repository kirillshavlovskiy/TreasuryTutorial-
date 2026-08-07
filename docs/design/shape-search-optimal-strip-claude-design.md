# Design brief — Shape search · Optimal strip @ WAM

**Refinement only** — modal chapter 3 (after Settle WAM). Parent: `hedge-carry-profile-modal-claude-design.md`

**Code:** `CashCarryAnalyticsView.tsx` · `optimizeStripShapeAroundWam` in `lib/test-mode/cash-carry-analytics.ts`

No screenshots required.

---

## Flow

1. User picks WAM on Settle WAM chart (bullet curve)
2. **This block** — grid search: strip count × CoM × kurtosis @ pinned WAM → max Enhancement
3. **Apply shape** — locks shape; WAM chart rebuilds on shaped ladder; user can re-check optimal WAM

**Leg sizing:** Sched-% weights × total hedge Δ (not exposure-path intersection). Preview table shows exact Δ per leg + settle month.

---

## Components

| Part | Content |
|------|---------|
| **Header** | `Shape search @ M{n}` · objective helper · **Apply shape** CTA |
| **Best card** | Strip · N · CoM · kurt · Enhancement · vs bullet · schedule · Σ Δ |
| **Preview cards** | Preview Enhancement · vs bullet @ WAM |
| **Knobs** | Legs · CoM · Kurtosis sliders/inputs |
| **Rank table** | Top shapes — click row loads knobs |
| **Preview legs** | Table: leg · settle · Δ · Sched % |

---

## Locked style

- Section: `border-slate-700 bg-slate-950 p-3`
- Title: `text-violet-200`
- Best card: `border-emerald-700/40 bg-emerald-950/30`
- CTA: `border-emerald-700/50 bg-emerald-950/40 text-emerald-200`
- Tables: `text-[10px] font-mono`

---

## Problems to fix

1. Dense block inside already-tall modal — needs tighter hierarchy
2. Best vs Preview vs Rank relationship unclear at a glance
3. Apply shape outcome (what changes on WAM chart) needs inline hint
4. Preview legs table should align visually with Carry Evolution per-leg bars

---

## Prompt for Claude Design (paste)

```
Refine modal chapter “Optimal strip around WAM” (shape search) — dark FX desk UI.

CONTEXT: User pinned WAM on Settle WAM chart. Optimizer searches legs × CoM × kurtosis; leg Δ = Sched-% × hedge Δ.

COMPONENTS: Header + Apply shape · Best shape card · Preview knobs + cards · Rank table · Preview legs (Δ × settle)

IMPROVE: Scan best shape in <3s · clear Best vs Preview · compact rank table · Apply shape affordance + one-line outcome hint

OUTPUT: Section layout spec · card hierarchy · table columns · Apply CTA placement
```
