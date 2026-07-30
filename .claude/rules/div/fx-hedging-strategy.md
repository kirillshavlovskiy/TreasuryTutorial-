# FX 2026 Hedging and Risk Management Plan

> Source: FX Hedging and Risk Management Plan 2026
> Owner: FX Team (Dor + Kirill)
> This is the active trading and automation strategy for 2026.

---

## Macro Context — USD Outlook 2026

**In-house view:** Gradual USD devaluation against all major peers and EM currencies.

**Short-term (as of Jan 2026):**
- US nonfarm payrolls came in stronger than expected (+130K vs ~65-70K consensus)
- Unemployment fell to 4.3%; but 2025 benchmark revisions showed much weaker underlying hiring (~181K vs previously reported ~584K)
- Near-term labor resilience → weakens case for imminent Fed rate cuts → short-term USD support

**Scenarios:**

| Scenario | Signal | Strategy | Instruments |
|----------|--------|----------|-------------|
| Labor resilience persists | USD strengthens, Fed cuts delayed | Sell EUR/USD and majors on rallies | Short call volatility, short TARF structures vs USD |
| Data weakens (revisions persist) | Easing expectations return | Buy FCY/USD on dips | Short currency put volatility, short TARF structures vs USD |

---

## EUR/USD Hedging Decision Matrix

| Market Structure | Momentum | Market Mood | Hedge Type | Option Style | Target Delta |
|-----------------|----------|-------------|------------|--------------|--------------|
| Strong uptrend (EUR above 200DMA) | Trend strong | Calm | Light hedge — sell OTM calls | Sell OTM calls | 70–80 |
| Strong uptrend | Overbought | Any | Temporary protection | Short-term ATM put | 65–75 |
| Sideways / Transition (around 200DMA) | Mixed | Normal | Balanced — collar | ATM put + OTM call | 50 |
| Sideways / Transition | Calm (cheap vol) | Calm | Add protection | Buy ATM put | 50–55 |
| Sideways / Transition | Stress (expensive vol) | Stress | Reduce exposure directly | Short swap + small call sale | 50 |
| Downtrend (below 200DMA) | Negative | Calm / Normal | Strong hedge | ATM put + partial swap | 20–30 |
| Downtrend | Panic / High stress | Stress | Control cost | Put spread | 25–35 |
| Breakdown + widening US rate advantage | Strong USD | Any | Hard hedge | Mostly swap + small put | 20–25 |

*Decision matrix to be validated with banks and embedded with risk management decision layer.*

---

## 2026 Automation Targets

### Trading Automation
- **FX Swap netting:** Implement automatic swap netting to decrease P&L fluctuations; balance P&L between NP interest and FX P&L
- **NP liquidity optimization:** API-based automatic swap trading based on cash balance
- **Multi-instrument decision algorithm:** Choose between FX Swap, FX Spot, and FX Option based on:
  - Current FX position (Cash vs Forward)
  - NP cash position
  - Market momentum indicators (RSI, 200DMA)
  - Volatility
  - Automatic hedging strategies from banks offering quantitative index trading solutions
- **TARF integration:** Add TARF as a hedging instrument; implement auto-hedging in format "Buy FX Spot now + sell TARF" (controls positive P&L cap)

### Risk & Accounting Automation
- Options lifecycle: fully automated accounting (required by accounting team)
- Financial FX reporting aligned with FX hedging reporting (manual reconciliation initially)
- M2M independent calculation (in-house or via LSEG/Bloomberg)
- VAR calculation and stress testing via external tools
- Greeks and essential option portfolio parameters calculation

### FX Forecasting
- Make Notional Pool FCY cash forecast reliable and automated
- Use forecast as input for automated hedging decisions

---

## 2026 Product Initiatives

- **FWD FX Rate fixing** for payrolls
- **FX Orders** for contractors
- **FXALL Settlement Center** back-feed into TMS → target 0 discrepancy between Accounting, Cash Management, TMS booking, and P&L modules
- **FX P&L and Exposure completeness:** Map all FX risk sources to TMS; capture missing edge cases from the platform

---

## Rules for Claude

- When discussing FX hedging decisions, reference the decision matrix above for instrument selection
- TARF structures: always note they cap positive P&L — confirm intent before suggesting
- Automation initiatives are 2026 priorities — flag if a proposed solution contradicts the automation roadmap
- VAR / stress testing: external tools (LSEG, Bloomberg) are the target — do not rely on manual calculation
- NP liquidity: swap-based optimization is preferred over spot conversion where available
