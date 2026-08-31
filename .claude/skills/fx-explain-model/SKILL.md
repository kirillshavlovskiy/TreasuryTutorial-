---
name: fx-explain-model
description: Explain a financial formula, function or number in this repository in plain language, before anyone changes it. Use when asked "what does this calculate", "why is this number what it is", "where does this formula come from", "what is H / the buffer / the swap leg", "can I change this", or before editing any financial calculation. Traces the code to the decision that defines it and the anti-patterns that protect it. Read-only — it never proposes or makes a change.
user-invocable: true
allowed-tools: Bash(git *), Bash(ls *), Bash(cat *), Bash(head *), Bash(tail *), Bash(grep *), Bash(rg *), Bash(find *), Read, Grep, Glob
---

# FX Explain Model

Explain what a calculation does and why it is shaped that way, for someone who works in Treasury
rather than in software.

Most "bugs" reported against this model are not bugs. They are a number that looks wrong until you
know which decision produced it. Read before you change.

## This skill is read-only

Never propose a change. Never edit a file. Never say "this looks wrong, we should…".

If the explanation reveals a genuine problem, say what you observed and stop:

> This does not match `<decision>`. That is worth checking with the FX lead before anything changes.

Then let the person decide. If they want a change, that is `fx-plan-task` and `fx-implement`.

---

## Step 1 — Find the code

**If you are starting from something on a screen, search for the words on the screen.** This is the
fastest route and the one people do not think of:

```bash
git grep -n "LIQUIDITY POOL BOOK" -- components app
```

Use the label exactly as it appears, capitals included. It lands on the component that renders it —
`components/UnifiedSimulator.tsx` for that one. The same works for `Target LP Cash`, `Swap Near`,
and any other visible label.

If you are starting from a name you already know:

```bash
git grep -n "<name>" -- lib components app
```

The financial model lives here:

| Area | Files |
|---|---|
| Buffer sizing, layered buffer, carry optimisation | `lib/fx-buffer.ts` |
| Hedging | `lib/fx-hedge.ts`, `lib/hedge-book-normalize.ts` |
| Carry accrual | `lib/carry-accrual.ts`, `lib/test-mode/cash-carry-analytics.ts` |
| Liquidity ladder and cycles | `lib/liquidity-ladder.ts`, `lib/forecast-profile.ts` |
| Dashboard aggregation | `lib/dashboard-model.ts` |
| VaR setup and analytics | `lib/test-mode/var-setup.ts` |
| Carry VaR allocation | `lib/portfolio-alloc.ts` |
| Cash-flow-at-risk | `lib/test-mode/cfar-*.ts` — `cfar-montecarlo`, `cfar-drawdown`, `cfar-timing`, `cfar-residual`, `cfar-funding-swap`, `cfar-frontier`, `cfar-net-by-ccy`, `cfar-job` |
| Market rates | `lib/fx-market-rates.ts` |
| Spreadsheet-style formulas | `lib/formula.ts`, `lib/sim-formulas.ts` |
| Screens | `components/LayeredBufferAnalysis.tsx`, `components/UnifiedSimulator.tsx`, `components/SwapOverlay.tsx`, `components/BufferOptimizer.tsx` |

## Step 2 — Find the decision that defines it

**This is the step that matters.** Almost every formula here has a written rationale.

```bash
grep -n -i "<concept>" .claude/rules/project/decisions.md
```

Also check `.claude/rules/project/liquidity-book.md` for anything touching the dashboard books.

Known map from concept to decision:

| If they ask about | Read this entry in `decisions.md` |
|---|---|
| the minimum cash threshold `H` | "Dynamic H threshold — Option A+B" (2026-04-29) **and** "H redefined — interest-rate optimization, not FX risk proxy" (2026-04-29) — the second supersedes the first for the liquidity buffer |
| the buffer scale, `computeLayeredBuffer` | "computeLayeredBuffer scale — |forecasted_cash|, not |payout|" (2026-05-28) |
| the swap near/far leg size | "Swap formula — both modes use spot-only restructuring" (2026-05-28) and "Swap restructuring sizing formula" (2026-04-29) |
| why the swap does not change net exposure | "Swap position netting in the balance sheet" (2026-04-29) |
| the liquidity book versus the swap band | `liquidity-book.md` |
| carry rates per currency | "CURRENCY_PARAMS carry rates — JPM NP rates, not central bank policy rates" (2026-04-30) |
| portfolio VaR and correlation | "Portfolio diversification VAR — 4th layer" (2026-04-30) |
| VaR profiles, forecast uncertainty, tenure | "Analytics VaR — profiles, horizon chart, forecast uncertainty" (2026-07-28) |
| token encryption | "Treasury token encryption — envelope versioning" (2026-08-13) |

If there is no entry, say so plainly: "This is not recorded in `decisions.md`." That is useful
information — it means changing it is less constrained, and also that nobody wrote down why.

## Step 3 — Find the policy behind the decision

Some numbers come from business policy, not from engineering choice. Check
`.claude/rules/div/fx-hedging-policy.md` and `.claude/rules/div/policy.md` for:

- position size approval thresholds — $50M, $100M, $250M
- VAR approval thresholds — $5M, $10M, $20M at 95% confidence
- automated hedge limit — $10M notional
- the hedging decision matrix and instrument selection

A threshold in code that matches one of these is not arbitrary and must not be "tidied up".

## Step 4 — Explain it

Write for someone who understands FX and does not write software.

Structure:

**What it calculates.** One or two sentences. Name the inputs in business terms — the FCY position,
the monthly payout, the carry differential — not in variable names.

**How, in words.** Describe the steps in plain language before showing any formula. Then show the
formula, and map each symbol to what it means.

**Where the numbers come from.** Which are live inputs, which are configured parameters, which are
hardcoded. Say which file holds each.

**Why it is shaped this way.** Quote the decision. Include the alternative that was rejected and
why — that is usually what the person is really asking.

**What must not change.** List the anti-patterns from the decision entry, in plain language. Be
concrete: "the scale is the position, not the monthly outflow" rather than "be careful with scale".

**What a change here would require.** Which review checklists apply (from
`fx-review/classify.md`), whether an approval threshold is involved, and whether the FX lead has to
sign off.

## Step 5 — Trace a specific number if asked

### First: decide which of three things is wrong

A number on a financial dashboard can be wrong for three different reasons, and they need three
different answers. Work through them in this order — the first is the most common and the cheapest
to confirm:

| | What to check | How you know |
|---|---|---|
| **1. The input data** | Is the rate, balance or position stale, missing, or from the wrong date? | The header badge reads "Treasury data unavailable", or a value is a static default rather than live. The app degrades quietly by design when Treasury or the database is unreachable |
| **2. The formula** | Is the calculation itself wrong? | Only worth checking once you know the inputs are right. This is what steps 1–4 above are for |
| **3. The display** | Is the calculation right and the screen wrong? | Wrong currency, wrong scale (units versus millions), wrong rounding, wrong sign. Check the component from step 1, not the calculator |

Say which of the three you concluded, and why. "The number looks wrong" is not yet a finding —
"the EUR row shows a static default because `TREASURY_MCP_URL` is unset" is.

If it turns out to be **1**, nothing in the model needs changing and you are done.

### Then: walk the number through

If they ask why one number came out as it did, walk the actual inputs through the actual code path
and show each intermediate value.

Do not guess and do not reconstruct from memory. Read the code path. If a value comes from live
data you cannot see, say which input you would need rather than inventing one.

**Never put a real balance, account identifier or counterparty name into a file, a commit, or a log
while doing this.** Explaining a number in conversation is fine; writing it down is not. See
`fx-review/check-financial.md` section 6.

## Vocabulary

Short definitions for terms that appear in the code. Fuller ones are in
`.claude/rules/div/fx-hedging-policy.md`.

| Term | Meaning here |
|---|---|
| FCY | any currency other than USD |
| NWC | net working capital — short-term assets minus short-term liabilities in a currency |
| NP | Notional Pool — the bank facility concentrating FCY cash in one place |
| `H` | the minimum cash threshold the model maintains in a currency |
| `H*` | the cost-optimal buffer level |
| spot / fwd | the FX position settling now / at a future tenor |
| near leg / far leg | the two halves of an FX swap; they net to zero exposure |
| carry | the interest-rate differential earned or paid for holding a currency |
| VaR | value at risk — the USD P&L impact of an adverse move, at a confidence level |
| CFaR | cash-flow at risk |
| M2M | mark to market — revaluing a position at current rates |
| Tf / Th | forecast period / VaR tenure. **Different things — do not conflate them** |
