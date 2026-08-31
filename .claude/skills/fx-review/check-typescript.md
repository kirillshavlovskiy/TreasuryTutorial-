# TypeScript checklist

TypeScript runs in strict mode here (`tsconfig.json` sets `"strict": true`). Type errors are part
of "done", not noise.

---

## 1. Types

- [ ] No `any`. Use `unknown` and narrow it explicitly.
- [ ] Interfaces describe data shapes (`FxPosition`, `HedgeOrder`, `CurrencyBalance`).
- [ ] Types alias unions (`type HedgeDirection = 'buy' | 'sell'`).
- [ ] Enums only for a genuinely closed set. String unions otherwise.
- [ ] A type error in test code is investigated, not suppressed. It is usually either a real bug in
      the fixture or a real bug in the function under test, and it is worth finding out which.

Do not trust a third-party library's TypeScript types as ground truth for its runtime behaviour.
Community type definitions can be wrong, or narrower than what the library actually does. When a
type error looks suspicious, verify against the library's own documentation or tests.

Source: `CLAUDE.md` → Code Style, Working with AI-Generated Code;
`.claude/rules/project/engineering.md`.

## 2. Naming

These rules exist so that both people and AI tools can reason about the code correctly.

- [ ] **Never reuse a name for two different concepts** anywhere in the codebase.
- [ ] Monetary amounts end in `Amount` or `Notional` — `hedgeNotionalAmount`, `exposureAmountUsd`.
- [ ] Currency codes end in `Currency` — `baseCurrency`, `settlementCurrency`.
- [ ] Instants end in `At`; calendar dates end in `Date` — `settledAt`, `valueDate`.
- [ ] Booleans start with `is`, `has` or `should` — `isRestricted`, `hasApproval`, `shouldHedge`.
- [ ] FX exposure variables use the established names: `exposureAmount`, `hedgeRatio`, `varEstimate`.
- [ ] Files and directories are kebab-case, fully spelled out. `fx-position-calculator.ts`, not
      `fxPosCalc.ts`.
- [ ] FX-specific modules are named `fx-*.ts`.
- [ ] Function names describe the full action — `calculateNetCurrencyExposure`, not `calcExp`.
- [ ] A variable is not named after its type: `const position = ...`, not
      `const fxPosition: FxPosition = ...`.

Source: `.claude/rules/project/engineering.md`; `.claude/rules/div/standards.md`.

## 3. Function design

- [ ] Functions are small and single-purpose.
- [ ] `async`/`await`, not raw promise chains.
- [ ] **No function silently reinterprets its input** to mean something different from what the
      caller expects. A parser that normalises an enum value "just to be safe" is the exact shape of
      a bug that reached production here and silently broke a scoring path.
- [ ] If two call sites genuinely need different normalisation for the same shape, that is **two
      functions with two names**, not one function with a hidden special case.

Source: `CLAUDE.md` → Code Style.

## 4. Changing a shared function

- [ ] Before renaming, retyping, or changing what a shared function returns, **every caller has
      been checked**. Fixing one call site while silently breaking another is a common failure of
      AI-assisted edits.
- [ ] Grep for the symbol across the repository and list the call sites in the review.

Source: `CLAUDE.md` → Working with AI-Generated Code.

## 5. Cleanliness

- [ ] No dead code, no commented-out blocks, no unused imports.
- [ ] No abstraction created for a single use. No premature generalisation.
- [ ] No helper utility introduced for a one-off operation.
- [ ] No backwards-compatibility shim for code that was removed.
- [ ] No docstring or comment added to code the change did not touch.

Source: `CLAUDE.md` → Code Style, What NOT to do.
