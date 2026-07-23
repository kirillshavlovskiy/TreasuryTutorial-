# Engineering Practices

> Maintained by: all team members
> Update when team decisions change practices. Commit alongside the code.

---

## Project Structure

```
<repo-root>/
├── README.md                    # Public-facing: what it does, how to run it
├── CLAUDE.md                    # AI instructions — framework notation + @-imports
├── .claude/
│   ├── framework.json           # Framework config (auto-generated, commit it)
│   ├── framework-readme.md      # Fetched from GDrive — do not edit manually
│   ├── framework-setup.md       # Fetched from GDrive — do not edit manually
│   ├── registry.json            # GDrive folder IDs (auto-generated, commit it)
│   ├── commands/                # Slash commands for Claude Code — commit them
│   └── rules/
│       ├── dept/                # Department knowledge — read-only, sync-managed
│       ├── div/                 # Division knowledge — read-only, sync-managed
│       └── project/             # This project's knowledge — team editable
├── src/                         # All source code
│   ├── lib/                     # Pure business logic — no framework dependencies
│   ├── api/                     # Route handlers / controllers
│   ├── services/                # External integrations (MCP calls, HTTP clients)
│   └── types/                   # Shared TypeScript interfaces and enums
├── tests/                       # Integration and e2e tests (co-locate unit tests)
├── docs/                        # Long-form documentation (architecture diagrams, runbooks)
│   └── decisions/               # One file per ADR if growing beyond decisions.md
└── scripts/                     # One-off operational scripts — never imported by src/
```

Co-locate unit test files with source: `src/lib/fx-calculator.ts` → `src/lib/fx-calculator.test.ts`

---

## Naming Conventions

### Files and directories
- **Kebab-case** for all files and directories: `fx-position-calculator.ts`, `hedge-approval-service.ts`
- Be fully descriptive — no abbreviations: `calculateFxExposure` not `calcFxExp`
- Prefix with domain when file lives outside a domain folder: `fx-position.ts` not `position.ts`

### TypeScript
- **Interfaces** for data shapes: `FxPosition`, `HedgeOrder`, `CurrencyBalance`
- **Types** for unions/aliases: `CurrencyCode = string`, `HedgeDirection = 'buy' | 'sell'`
- **No `any`** — use `unknown` and narrow explicitly
- **Enums** only for truly closed sets (e.g. `HedgeStatus.Pending`); use string unions otherwise
- Function names describe the full action: `calculateNetCurrencyExposure`, `submitHedgeOrderToTms`

### AI-friendly naming rules
These rules make code easier for Claude and other AI tools to reason about correctly:
- Never reuse a name for two different concepts anywhere in the codebase
- Financial amounts: always suffix with `Amount` or `Notional` (`hedgeNotionalAmount`, `exposureAmountUsd`)
- Currency codes: always suffix with `Currency` (`baseCurrency`, `settlementCurrency`)
- Timestamps: always suffix with `At` for instants, `Date` for calendar dates (`settledAt`, `valueDate`)
- Boolean flags: prefix with `is`, `has`, `should` (`isRestricted`, `hasApproval`, `shouldHedge`)
- Do not name variables after their type: `const position = ...` not `const fxPosition: FxPosition = ...`

---

## Markdown Documentation Files

| File | Purpose | Who edits | When to update |
|------|---------|-----------|----------------|
| `README.md` | Public project overview — setup, purpose, links | Everyone | When setup or purpose changes |
| `CLAUDE.md` | AI framework notation — do not edit the framework block | Run `/update-claude-md` | When adding project-specific AI rules |
| `.claude/rules/project/context.md` | Sprint goals, stakeholders, blockers | Everyone | Each sprint start; when blockers change |
| `.claude/rules/project/decisions.md` | Architecture decisions (ADRs) | Everyone | When a meaningful architecture choice is made |
| `.claude/rules/project/setup.md` | Dev environment, commands, env vars, gotchas | Everyone | When setup changes |
| `.claude/rules/project/engineering.md` | This file — team engineering practices | Everyone | When practices change |
| `docs/` | Long-form docs: runbooks, architecture diagrams | Everyone | As needed |

**Rule:** `.claude/rules/project/` files are committed to the repo. They are the single source of truth for Claude's understanding of this project. Keep them current.

---

## Version Control

### Branch naming
```
feature/<ticket-id>-<short-description>    # new capability
fix/<ticket-id>-<short-description>        # bug fix
chore/<ticket-id>-<short-description>      # non-functional: deps, config, tooling
docs/<ticket-id>-<short-description>       # documentation only
```

### Commit message format (Conventional Commits)
```
<type>(<scope>): <short summary in present tense>

[optional body — explain WHY, not WHAT]
[optional footer — references: Closes #123, Breaking change: ...]
```

**Types:** `feat` `fix` `chore` `docs` `test` `refactor` `perf`

**Scope:** module or area affected — `fx-calculator`, `hedge-service`, `tms-client`

**Rules:**
- Summary line ≤ 72 characters, no period at end
- Body explains the motivation, not just what changed
- Always reference the Linear/Jira ticket in the footer
- One logical change per commit — do not bundle unrelated changes

**Good examples:**
```
feat(hedge-service): add TARF instrument support

Requested by FX lead for 2026 automation strategy. TARF caps positive
P&L on the structure — always confirm intent before executing.

Closes FX-142
```
```
fix(fx-calculator): correct restricted-currency P&L exclusion

Restricted currencies (Model 3) were being included in trading P&L KPI.
Per hedging policy, these are exposure-only and must not appear in P&L.

Closes FX-156
```

---

## Testing

### Categories
- **Unit tests** — pure functions, business logic, calculators. Co-located: `*.test.ts`
- **Integration tests** — MCP calls, service boundaries. In `tests/integration/`
- **No mocks for MCP calls** — use real MCP sandbox; mock/prod divergence has burned us before

### Rules
- Test file names mirror source file names: `fx-calculator.ts` → `fx-calculator.test.ts`
- Each test describes behavior, not implementation: `'returns USD when exposure is zero'` not `'calls getBalance'`
- Integration tests hit real MCP endpoints using sandbox/staging — never production data
- Cover edge cases explicitly: zero exposure, single-currency portfolio, restricted currency

### Running tests
```bash
npm test                    # all tests
npm test -- --watch         # watch mode
npm test -- fx-calculator   # single file
```

---

## Working with AI (Claude Code)

- Commit `.claude/rules/project/` files — Claude reads them automatically in every session
- When Claude makes a non-obvious decision, ask it to record the reasoning in `decisions.md`
- After each sprint, update `context.md` with new goals before starting the next sprint
- When adding a new environment variable or gotcha, update `setup.md` immediately
- The `/sync-dept` and `/sync-division` commands refresh knowledge from GDrive — run them when upstream docs change

---

## Claude Behavior Rules (enforced)

### Scope of md file updates
- Only update a project/ md file when the user **explicitly confirms** something should be recorded
- Never speculatively fill in `decisions.md`, `setup.md`, or `context.md` based on inferred context
- Only write the specific fact or decision discussed — do not expand the file beyond what was asked
- Do not add sections, examples, or commentary beyond the single update requested

### File and component creation limits
- Do not create new files unless the task cannot be completed by editing an existing one
- Do not create helper files, utility modules, or abstraction layers unless explicitly requested
- Do not scaffold more than what was directly asked for — no bonus components, no "while I'm at it" additions
- Maximum one new file per task unless the user explicitly asks for multiple

### Project size discipline
- Before creating any file, confirm there is no existing file that can be extended instead
- Do not split logic into multiple files when one file is sufficient
- Do not create index files, barrel exports, or re-export wrappers unless explicitly asked
- `docs/` and `scripts/` directories: only create if the user asks for them
