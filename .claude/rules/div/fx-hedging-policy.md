# FX Hedging Policy — Deel Treasury

> **Business Policy** — Approved by: Treasury Manager / Director of Finance
> Source: FX Hedging Policy (Aug 2024 WIP)
> This is a BUSINESS policy, not a development policy. It defines rules, limits, and approval processes.

---

## Glossary

**FCY (Foreign Currency):** Any currency denominated other than USD.

**FX financial transactions:** Financial and capital transactions between the Company and any external counterparty resulting from execution of financial contract(s), which create an imbalance between consolidated asset and liability balance sheet accounts in the original contract currency(s). Must be supervised, managed and reported according to this Policy.

**FX Exposure:** Any existing or expected imbalance between consolidated asset and liability balance sheet accounts (including accrued interest in foreign currency) nominated in a currency different from the reporting currency (USD), arising from FX financial transaction(s) execution or P&L accounted in foreign currency. Must be supervised, managed and reported according to this Policy.
- **Current FX Exposure** — already reflected balance sheet asset/liability imbalance in a given FCY on cash or non-cash accounts
- **Future FX Exposure** — expected (forecasted) balance sheet asset/liability imbalance in a given FCY where the amount is already defined or calculable in FCY, but the USD equivalent is not yet fixed

**FX Hedging:** FX transactions created to limit or remove FX Exposure. Can be executed both before and after FX financial transactions have been accounted for in the financial system.

**P&L accounted in foreign currency:** Difference between consolidated asset and liability accounts of a subsidiary's balance sheet nominated in a currency different from the reporting currency (USD).

**Duration of FX financial transaction:** Time period during which an FX financial transaction is kept unsettled (i.e. no corresponding FX Hedging transaction has been executed to manage the FX risk arising from it).

**Revaluation of FX Exposure (Mark to Market / M2M):** Difference in revenue impact from translating all company asset and liability balances into the reporting currency (USD) at current exchange rates versus the previous period exchange rate.

**FX Gain:** Positive revaluation of FX Exposure.

**FX Loss:** Negative revaluation of FX Exposure.

**Hedging Strategy:** Regular execution of one or a set of Hedging FX financial transactions based on established rules and practices, in order to systematically: manage FX risk, manage FCY/USD liquidity, manage interest margins, manage tax benefits, and optimize the overall FX structure.

**Hedging Tools:** Internally created and managed reports and files used to inform FX Traders about FCY cash positions and FX positions, enabling timely hedging decisions.

**TMS (Treasury Management System):** Master system for FX and liquidity risk management — dashboards, cash positions, M2M P&L, interest margins. TMS is the single source of truth for FX exposure.

**Net Working Capital FX Exposure (NWC FX):** Short-term assets minus short-term liabilities in FCY = the FX position in that currency. Must be kept within defined Exchange Rate Risk limits.

**Exchange Rate Risk:** The risk that the company's cash flows will be adversely affected by movements in exchange rates that increase the value of foreign currency payables or diminish the value of foreign currency receivables.

**Notional Pool (NP):** Banking tool that concentrates FCY cash positions in one Treasury Hub location. Allows short FCY positions (overdrafts) collateralized by long positions in other currencies or USD.

---

## Objectives

This policy provides an overall framework for managing corporate foreign currency exposures and FCY liquidity by:

1. Effectively identifying, assessing and monitoring FX and liquidity risks in compliance with legal requirements, regulations, and corporate management needs
2. Executing FX/MM financial transactions to follow the defined hedging strategy, risk tolerance within well-defined probability bounds, and VAR limits
3. Minimizing the negative and maximizing the positive impact of translation and economic risks on the company income profile
4. Defining intergroup FX transfer pricing to account for market liquidity, volatility and cost of capital utilization — pricing the cost of hedging into clients and partners across currency legal contracts
5. Controlling and reporting P&L associated with carried Exchange Rate Risk
6. Minimizing adverse impact of hedging transaction taxation on corporate net income
7. Defining how hedging performance will be measured and remunerated
8. Defining how the policy and its separate sections will be reviewed and approved in the future

---

## FX Position Calculation

- All FX positions are measured against USD (consolidated reporting currency)
- All currency balances across the Deel Inc subsidiary structure are included in the position calculation
- **Three collection and hedging models:**

  **1. Global collection + Notional Pool sweep:**
  Funds collected globally into Deel Inc, swept to NP account. FX hedging operates independently of the funding/sweep process. Executed in all NP currencies.

  **2. Local collection + conversion on demand:**
  Funds collected locally, converted to salary payout currency as needed.

  **3. Restricted currencies (funding-linked FX):**
  Where FX conversion cannot be separated from the funding process (currencies that cannot be borrowed or held offshore). These operations are tracked separately. Even when FX is executed, it is NOT treated as trading activity measured by P&L KPI. However, these positions ARE included in open currency position calculation for each currency.

---

## Hedging Instruments

- Today / Overnight / Spot FX contracts (deliverable)
- Forward Contracts (T+3 and later, deliverable)
- NDF — Non-Deliverable Forwards
- Cross-currency (interest rate) SWAPs (vanilla and hybrid) and other Money Market (MM) instruments
- FX Options (any kind)
- FX Derivatives of higher order (non-vanilla hybrid structures)
- Combinations of the above as a set of separate trades of same or different types

---

## Hedging Policy Execution

All short-term liabilities (client balances and contract balances) should be netted with short-term assets (bank account balances). Exposures arising from the netting should be hedged using:
- Up to Spot FX contracts — if funding of the FCY account is required immediately (within 2 business days)
- Forward contracts — if funding is required more than 2 business days from the hedging decision moment

Hedging of exposure is possible in two forms:
- **Opened contract** — undefined duration of the hedged exposure or undefined economic P&L
- **Normal hedging** — defined duration and economic P&L of the hedged exposure

---

## NWC Hedging Approaches

FCY Net Working Capital can be managed as:
1. Converted to USD to minimize translation risk
2. Kept as long FCY position (market view)
3. Kept as short FCY position/overdraft (market view, requires approval)
4. Held as a combination of long cash and FX positions for carry trade
5. Hedged via NDF or non-deliverable options
6. Hedged via overnight FX Swap

> Note: There may be markets where selling FX onshore imposes taxation consequences for the Deel subsidiary, limiting NWC management options. Risk-averse strategy assumes FCY NWC is minimized or kept at 0 at any point in time.

---

## Currency Exposure Management through Notional Pools (NP)

Notional Pool (NP) is a liquidity and funding banking tool facilitating outgoing payments through cash concentration services in one Treasury Hub location. USD collateral can be used to fund FCY business operations, fund Swaps or FX/MM hedging instrument settlement, and be deposited as margin collateral.

NP is comprised of a Cash Currency Position and non-cash liability as components of the company Net Working Capital. NP allows companies to carry short FX or FCY positions with the aid of FCY credit lines collateralized by long cash positions in other FCYs or USD.

Funding sources (may be applied separately or in combination):
- **Cash WC funding in FCY:** USD collateral is converted into funded foreign currency through deliverable instruments (FX Spot, Forwards, Deliverable Options) or FCY is collected and deposited directly
- **NP funding in FCY:** USD/FCY collateral funds borrowing in another FCY
- **Swap funding in FCY:** USD/FCY collateral is temporarily converted to another FCY/USD (o/n or longer-term within the payment cycle)

All hedging and funding transactions are consolidated in the same NP with other cash balances as part of the net FX and cash position. NP facilitates NWC conversion from one currency into another in any direction and concentrates M2M P&L and net interest margin in one single location.

> If a position is funded through NP, a negative balance in foreign currency is allowed **only if** USD credit interest rate > FCY debit interest rate; otherwise negative balance requires approval of the Director of Finance.

---

## FX Exposure Hedging

Hedging activity is intended to meet current and anticipated future FX exposures, combining minimization of FX risk with maximization of:
- Expected FCY and USD interest margins through o/n and short-term interest rate instruments or deposits
- Current and future FX exposure M2M positive revaluation effects on corporate income profile
- FX/MM hedging instrument opportunity cost savings (hedging cost minimization)

**Hedging transaction types:**
- Funding: Spot, Forward, FX Swap, Deliverable Options
- Non-funding: NDFs, IRS, Options, and other non-vanilla derivatives

**Hedging strategies by business operation type:**
- Regular business operations: EOR Pay-ins, GP Pay-ins, Contractor Pay-ins, Contractor Withdrawals, Deposits, Refunding transactions, Transaction Reversals
- P&L/Interest accrual hedging
- Funding operations hedging (borrowing, bond issuance)
- Investment operation hedging (M&As, IPO)

---

## Hedging Scenarios by Transaction Type

| Hedging Scenario | FX Position before invoice pricing | FX Position after contract pricing before hedging | Where Allowed | Funding/Hedging Strategy | FX Hedging Instruments |
|---|---|---|---|---|---|
| **Forecast based** | | | | | |
| Pay-outs pre-hedge based on TMS forecast on/before expected due date | Long FCY / Short USD | Any (depends on forecast accuracy) | Any (if derivatives supported) | Advance funding — positive currency outlook | Spot, FWD, Options (Settlement date ≤ Payout date) |
| Pay-outs pre-hedge based on TMS forecast after expected due date | Long FCY / Short USD | Any (depends on forecast accuracy) | Any (if derivatives supported) | Late funding — positive currency outlook | FWD, Options (Settlement date > Payout date) |
| **Individual based (Actuals)** | | | | | |
| Pay-ins/Pay-outs/Withdrawals/Deposits at invoice due date | Flat | Flat | Notional Pool CCYs | In-time — neutral currency outlook | TOM, Spot, FWD, Options (Settlement date = Payout date) |
| Pay-ins/Pay-outs/Withdrawals/Deposits after due date | Flat | Flat | Notional Pool CCYs | Late funding — neutral currency outlook | TOM, Spot, FWD, Options (Settlement date > Payout date) |
| Pay-ins/Pay-outs/Withdrawals/Deposits after pricing at due date | Flat | Short FCY / Long USD | Notional Pool CCYs | In-time funding — negative currency outlook | TOM, Spot (VD = Due date) |
| Pay-ins/Pay-outs after collection after due date | Flat | Short FCY / Long USD | Any | Late funding — negative currency outlook | TOM, Spot, FWD, Options (VD > Due date) |
| Pay-ins/Pay-outs after collection before due date | Flat | Short FCY / Long USD | Any | Pre-funding — negative currency outlook | TOM, Spot (VD > Due date) |
| **Actual Exposure based** | | | | | |
| NWC (current) FX exposure hedging | N/A | Any | Notional Pool Currencies | Normal FX position hedging | Spot, FWD |
| Non-NWC (strategic) FX exposure hedging | N/A | Any | Notional Pool Currencies | Normal FX position hedging | FWD, Options, non-vanilla derivatives |

---

## Currency Exposure and Liquidity Hedging

FCY liquidity procedure considers forecasting exposures on Daily, Weekly and Monthly basis:
- **Daily:** Forecast recalculated with new inputs every morning (BOD)
- **Weekly:** 1-week horizon, manage FCY exposure profile for up to 1 week
- **Monthly:** 1-month horizon, manage FCY exposure profile for up to 1 month

**Forecast inputs:**
- Existing payroll and payout data
- Predicted growth rate
- Predicted off-cycle volume fluctuations
- Inflation impact
- Bonus payments
- Existing invoice and financial transaction inputs (current and future settled)
- Current FX and cash exposure

**Model output parameters:** Upper FCY balance, Lower FCY balance, Time-weighted FCY balance

---

## Liquidity Hedging — Decision Matrix (Neutral Currency Outlook)

Cash instrument layer:

| Forecast | Daily | Weekly | Monthly |
|---|---|---|---|
| Short Cash / FX FCY position | Buy TD/Spot | Buy Spot / 1w FWD | Buy Spot / 1m FWD |
| Short Cash / Flat FX FCY position | No action | Buy TD/Spot + sell Call 1w | Buy TD/Spot + sell Call 1m |
| Short Cash / Long FX FCY position | Sell TD/Spot + o/n FX Swap | Sell Spot / 1w FWD / 1w Option + 1w FX Swap | Sell Spot / 1m FWD / 1m Option + 1m FX Swap |
| Long FCY Cash / FX FCY position | Sell TD/Spot | Sell Spot / 1w FWD / 1w Option | Sell Spot / 1m FWD / 1m Option |
| Long FCY Cash / Flat FX FCY position | No action | Sell TD/Spot + buy Call 1w | Sell TD/Spot + buy Call 1m |
| Long FCY Cash / Short FX FCY position | Buy TD/Spot | Buy Spot / 1w FWD / 1w Option | Buy Spot / 1m FWD / 1m Option |
| Flat FCY Cash / FX FCY position | No action | No action | No action |
| Flat FCY Cash / Short FX FCY position | Buy TD/Spot | Buy Spot / 1w FWD / 1w Option | Buy Spot / 1m FWD / 1m Option |
| Flat FCY Cash / Long FX FCY position | Sell NDF | Sell 1w NDF | Sell 1m NDF |

NP / FX Swap alternatives (when position funding/investment is needed):

| Forecast Scenario | Daily | Weekly | Monthly |
|---|---|---|---|
| Short FCY Cash / FX position | NP overdraft or Buy o/n FX Swap | NP overdraft or Buy 1w FX Swap | NP overdraft or Buy 1m FX Swap |
| Short Balance / Flat FX position | NP overdraft or Buy o/n FX Swap | NP overdraft or Buy 1w FX Swap | NP overdraft or Buy 1m FX Swap |
| Short Cash / Long FX FCY position | NP overdraft or Buy o/n FX Swap | NP overdraft or Buy 1w FX Swap | NP overdraft or Buy 1m FX Swap |
| Long FCY Cash / FX position | WC investment through NP or Sell o/n FX Swap | WC investment through NP or Sell 1w FX Swap | WC investment through NP or Sell 1m FX Swap |
| Long FCY Cash / Flat FX position | WC investment through NP or Sell o/n FX Swap | WC investment through NP or Sell 1w FX Swap | WC investment through NP or Sell 1m FX Swap |
| Long FCY Cash / Short FX FCY position | WC investment through NP or Sell o/n FX Swap | WC investment through NP or Sell 1w FX Swap | WC investment through NP or Sell 1m FX Swap |
| Flat FCY Cash / FX position | N/A | N/A | N/A |
| Flat FCY Cash / Short FX position | N/A | N/A | N/A |
| Flat FCY Cash / Long FX FCY position | N/A | N/A | N/A |

> Note: Spot conversion may replace Swap transactions if Swaps/Forwards are not available.

---

## Trading Strategy

FX and cash/currency exposure hedging strategy is an ultimate combination of hedging scenarios chosen with respect to: market view, access to cash liquidity within the selected forecasting horizon, immediate access to liquidity (including pooling solutions), and funding policy.

Strategy may be implemented through manual or automated FX financial transaction processes with financial institutions or PSPs, supplemented by non-FX instruments (Swaps, interest rate derivatives, loans, etc.) depending on business needs and market conditions.

**Classification by goals:**
- Lock in Spread / Spot-Forward rate differential
- Lock in upfront option premium
- Maximize profit through option buying
- Minimize hedging/transactional cost
- Algo trading strategy (factoring in: current P&L, current FCY exposure and direction, current FCY balance, thresholds, product type)

A strategy may combine single or multiple goals.

**Classification by business process:**
- Swap booking to improve interest rate profile
- NDF trading to manage FX risk separately from the hedging/funding operation
- Hedging of current business operations
- Hedging of investment transactions
- Hedging of financing transactions
- Hedging of strategic financial transactions

---

## Hedging Strategy Approval

Hedging strategy can be changed and approved by:
- Hedging Desk Head
- Treasury Head
- Director of Finance

---

## Approval Thresholds

### FX Position Size Limits (USD equivalent)

Any FX position creation above these limits requires the respective order of authority approval:

| Exposure | Approval Required |
|---|---|
| > $50M | Director of Finance |
| > $100M | CFO |
| > $250M | CEO |

NWC level calculation in any FCY is also subject to unhedged (NWC) position authorization.

### Stressed P&L VAR Limits (95% confidence)

| VAR | Approval Required |
|---|---|
| > $5M | Director of Finance |
| > $10M | CFO |
| > $20M | CEO |

For forecast-based hedging, Forecasted VAR is calculated by summing all existing FX exposure VAR and Forecasted FX Exposure VAR. Forecasted VAR must satisfy the same limitations as simple VAR.

---

## Benchmarking of FX Exposure Risk

Main drivers of Stressed FX P&L change used to execute controls and run stress tests:
- Exposure value with direction
- Time period of exposure existence
- Volatility of the currency
- Interest rate differentials
- Volatility of interest rates

---

## Change Process

To change risk thresholds and trading limits: both **CFO and CRO** approvals are mandatory.

---

## Rules for Claude

- Never suggest FX trading decisions without referencing TMS exposure data
- FX exposure approval thresholds are hard limits — always flag when a proposed hedge exceeds them
- Restricted currency operations are NOT P&L KPI items — do not treat them as trading activity
- NWC FX position must be kept within approved VAR limits at all times
- All hedging strategy changes require approval (Hedging Desk Head / Treasury Head / Director of Finance)
- For forecast-based hedging, always calculate Forecasted VAR across the full forecasting horizon
- NP negative balance in FCY requires Director of Finance approval unless USD credit rate > FCY debit rate
- TARF and non-vanilla derivative structures always require FX Lead sign-off regardless of notional size
