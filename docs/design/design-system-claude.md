# Design system — Treasury Workbench (Claude Design kit)

**Source of truth** for visual language across Analytics, Cash Carry, CFaR, hedge modals, and entity onboarding.  
Briefs should say “same kit as `docs/design/design-system-claude.md`” instead of reinventing tokens.

**Tone:** Dark desk UI · dense · mono figures · refinement only. Not marketing.

**Code anchors:** `components/test-mode/*` · `RiskPerspectiveSelector` · `CashCarryAnalyticsView` · `CfarAnalysisView` · `ExposureHedgePathChart`

**Exception:** the simulator desk (`UnifiedSimulator` · `LayeredBufferAnalysis` · `Simulator` tabs) is authored in *light* utilities and remapped to dark by `.sim-dark` in `app/globals.css`. Use the remap-safe tokens listed in `docs/design/fx-simulator-desk-claude-design.md`, not the `slate-*` classes below.

---

## Surfaces

| Token | Tailwind |
|-------|----------|
| Page / shell | `bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950` · `text-slate-100` |
| Panel | `rounded-xl border border-slate-700 bg-slate-900` (± `bg-slate-900/60` · `p-4` / `p-5`) |
| Section | `rounded-lg border border-slate-700 bg-slate-950/40 p-3` (solid `bg-slate-950` when chart needs opaque sticky cols) |
| Nested / expand | `rounded-md border border-emerald-500/30 bg-slate-950/70 p-3` |
| Chip / draft shell | `rounded-md border border-slate-700 bg-slate-950/60` (± `px-1.5 py-0.5`) |
| Modal | `max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl` |
| Backdrop | `fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm` |
| Readout band (risk) | `border-red-800/40 bg-red-950/20` or `border-yellow-800/40 bg-yellow-950/20` |
| Sticky modal header | `sticky top-0 z-10 border-b border-slate-800/80 bg-slate-900` |

### Hex map (for non-Tailwind tools)

| Hex / rgba | Tailwind |
|------------|----------|
| `#020617` · `rgba(2,6,23,.4/.6/.7)` | `slate-950` · `bg-slate-950/40` `/60` `/70` |
| `#0f172a` · `rgba(15,23,42,.6/.8)` | `slate-900` · `bg-slate-900/60` `/80` |
| `#1e293b` · `rgba(30,41,59,.5/.8)` | `slate-800` · `border-slate-800/80` |
| `#334155` | `slate-700` |
| `#475569` | `slate-600` |
| `#64748b` | `slate-500` |
| `#94a3b8` | `slate-400` |
| `#cbd5e1` | `slate-300` |
| `#e2e8f0` | `slate-200` |
| `#f1f5f9` | `slate-100` |

---

## Radius rhythm

| Use | Class | ~px |
|-----|-------|-----|
| Metric cards | `rounded` | 4 |
| Controls / chips | `rounded-md` | 6 |
| Sections | `rounded-lg` | 8 |
| Panels / modals | `rounded-xl` | 12 |

---

## Type

| Role | Class |
|------|--------|
| Modal / page title | `text-sm font-semibold text-white` / `text-slate-100` |
| Section title | `text-[11px] font-semibold` + semantic tint |
| Chapter label | `text-[9px] font-semibold uppercase tracking-wide text-slate-600` |
| Metric label | `text-[9px] font-semibold uppercase tracking-wide text-slate-500` |
| Metric value | `font-mono text-sm font-semibold tabular-nums` |
| Table body | `text-[10px] font-mono` |
| Table head | `text-slate-500` · row `border-t border-slate-800/80` |
| Meta / helper | `text-[10px]`–`text-[11px] text-slate-400` / `text-slate-500` |
| Mono context line | `font-mono text-[10px] text-slate-500` |

**Density:** 9–11px body everywhere. Prefer mono for money, tenors (`M6`), ratios, CCY codes.

---

## Money & figures

| Kind | Format | Example |
|------|--------|---------|
| Carry / risk $K | Signed `$K` | `+$12K` · `−$8K` · `$0K` |
| Notional / stock | Signed `M` | `+16.30M` · `−7.8M` |
| Percent | Integer or 1dp | `80%` · `u₁ₘ 15%` |
| Empty / zero-benefit | Em dash | `—` in `text-slate-500` / `text-slate-600` |

---

## Semantic colors

| Meaning | Tint (typical classes) |
|---------|------------------------|
| **Risk** — VaR · Resid VaR · CFaR · EaR | rose / red — `text-rose-300` · Net CFaR band yellow-amber when “critical cash” |
| **Credit / counterparty** | orange — `text-orange-300` / `border-orange-700/50` |
| **Carry** — Total · Δ · enhancement · win | emerald — `text-emerald-100`–`200` · `bg-emerald-500/20` |
| **Cover · Legs · sky figures** | sky — `text-sky-200` · `text-sky-300` |
| **Do nothing · breakeven · schedule · warn edit** | amber — `text-amber-200/90` · gear open `text-amber-200` |
| **Liquidity / funding gap** | fuchsia / amber — `text-fuchsia-300/80` |
| **CCY select · Decision violet** | violet — `bg-violet-500/25 text-violet-100` · row `bg-violet-500/10` |
| **Residual int** | `text-violet-200` |
| **FWD points** | `text-emerald-300` |
| **USD int · Opening** | `text-sky-300` |
| **Hedge CF · outflows** | `text-rose-300` / `text-rose-300/80` |
| **Neutral body** | `text-slate-100` / `text-slate-300` |
| **Progress done / current / locked** | emerald · sky · slate |

Negative money always falls back to `text-rose-300` even on emerald-labeled metrics.

---

## Controls

| Pattern | Classes |
|---------|---------|
| Segmented track | `inline-flex rounded-md border border-slate-700 bg-slate-950/60 p-0.5` |
| Segment on (default) | `bg-emerald-500/20 text-emerald-100` |
| Segment on (CCY / Decision) | `bg-violet-500/25 text-violet-100` |
| Metric / meta chip | `inline-flex items-baseline gap-1 rounded border border-slate-700 bg-slate-950/70 px-1.5 py-0.5` |
| Primary action | `rounded border border-emerald-700/50 bg-emerald-950/50 px-2.5 py-1.5 text-[10px] font-semibold text-emerald-100` |
| Prebook / violet CTA | `border-violet-500/50 bg-violet-500/20 text-violet-100` |
| Ghost / Close | `rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800` |
| Gear / schedule edit | Amber emphasis when open; editable inputs `border-amber-500/40 bg-slate-900 text-amber-100` |
| InfoTip “i” | `h-5 w-5 rounded-full border border-slate-600` · open `border-sky-500/60 bg-sky-500/20` |

---

## Interaction states

| State | Class |
|-------|--------|
| Row hover | `hover:bg-slate-800/50` or `hover:bg-violet-500/10` |
| Selected row | `bg-violet-500/10` or `bg-emerald-500/[0.12]` |
| Book / live package row | `bg-emerald-500/[0.08]` |
| Beyond Tf / disabled leg | `opacity-40`–`50` |
| Disabled control | `opacity-40 cursor-not-allowed` |
| Motion | `transition-colors` only — no decorative motion |

---

## Layout habits

- **One job per section** — one headline, one short helper, primary controls  
- **Cards only for interaction** (select asset class, pick objective) — not decorative wrappers  
- **Tables** for books, legs, tick trades — `overflow-x-auto` · `min-w-[640px]` when dense  
- **4-up metric grids** common for summary chapters  
- **Sticky** modal title bar; optional sticky first table column with opaque matching bg  
- **Chapter labels** `1 · Summary`, `2 · …` above section cards  

---

## Avoid

- Purple-on-white or purple→indigo marketing gradients  
- Warm cream + terracotta brochure look  
- Broadsheet / hairline / zero-radius newspaper columns  
- Glow stacks · `rounded-full` pill clusters · emoji  
- Inventing a new theme or light mode for these flows  
- Flat single-color hero pages (this kit is in-app desk chrome)

---

## One-liner (paste into Claude Design)

```
Same slate/emerald/violet/amber/rose desk kit · panels rounded-xl border-slate-700
bg-slate-900 · sections rounded-lg bg-slate-950/40 · 9–11px type · font-mono
figures · semantic: risk rose · carry emerald · cover sky · schedule amber ·
CCY violet · CP orange · refinement only · no marketing UI
```

---

## Related briefs

| Brief | Path |
|-------|------|
| FX Simulator desk (main component) | `docs/design/fx-simulator-desk-claude-design.md` |
| Entity onboarding | `docs/design/entity-onboarding-claude-design.md` |
| CFaR analysis | `docs/design/cfar-analysis-claude-design.md` |
| Liquidity analytics | `docs/design/liquidity-analytics-claude-design.md` |
| Liquidity frontier modal | `docs/design/liquidity-frontier-modal-claude-design.md` |
| Cash Carry · All CCY | `docs/design/cash-carry-all-currencies-claude-design.md` |
| Hedge carry profile modal | `docs/design/hedge-carry-profile-modal-claude-design.md` |
| Shape search optimal strip | `docs/design/shape-search-optimal-strip-claude-design.md` |
| Forecast profile | `docs/design/forecast-profile-balance-sheet-claude-design.md` |
| Cash Carry handoff (impl detail) | `docs/design/design_handoff_cash_carry_all_currencies/README.md` |
| Hedge modal handoff | `docs/design/hedge-carry-profile-handoff/README.md` |
