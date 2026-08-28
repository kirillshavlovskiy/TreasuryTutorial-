import { NORDTECH_ENTITIES } from '@/lib/test-mode/fixtures/nordtech-accounts';
import { withinTolerance } from '@/lib/test-mode/fixtures/nordtech-reference';
import { buildCashForecastCarryComparison } from '@/lib/test-mode/cash-carry-analytics';
import { consolidateEntityBooks } from '@/lib/test-mode/consolidate';
import { emptyMarketRatesForCcy } from '@/lib/fx-market-rates';
import {
  classifyNordtechEntity,
  mergedEntityForecastProfile,
  TASK01_REQUIRED_ANALYTICAL_LAYERS,
  TASK01_REQUIRED_DECISION_LAYERS,
  TASK01_REQUIRED_FX_INPUTS,
  TASK02_CARRY_CCYS,
  TASK02_FORECAST_MONTHS,
} from '@/lib/test-mode/nordtech-sim-seed';
import type {
  ScoreCheck,
  TaskAnswers,
  TaskScoreResult,
} from '@/lib/test-mode/types';
import {
  eurRefExposureM,
  expectedEurVarUsdM,
  parseVarSetup,
  setupLabel,
} from '@/lib/test-mode/var-setup';
import type {
  AnalyticalLayer,
  DecisionLayer,
  Entity,
  FxInput,
  Workspace,
} from '@/lib/workspace-store';

const HINTS = {
  entities:
    'Create three entities under the sandbox: NordTech US (USD), NordTech GmbH (EUR), and NordTech Poland (PLN). Use Reset sandbox if the tree is empty.',
  dashboards:
    'Each entity needs its own dashboard (e.g. EUR book / Payroll). Open the entity → + New dashboard.',
  profiles:
    'Add an FX risk profile on each subsidiary dashboard, then open the FX table to work the book.',
  group:
    'First finish every legal-entity dashboard + FX Risk profile (local positions). Then Group FX (consolidated) unlocks — open it for Hedging Decision (Δ = 1) and VaR.',
  fxInputs:
    'Select FX Input: FX Risk — Cash FX + Non-cash Asset / Liability. Liquidity / Rates / IR stay off.',
  decisionLayers:
    'On Add risk profile → Decision layers: enable Hedging Decision.',
  analyticalLayers:
    'On Add risk profile → Analytical layers: enable Risk Metrics (VaR). Sensitivity / Monte Carlo are optional.',
  mismatchCcy:
    'Largest stock mismatch is EUR long Net FX (cash + receivables − venture debt ≈ €1.9M). Enter currency code EUR.',
  mismatchAmt:
    'EUR exposure for your Analytics basis: Simple avg ≈ (S+E)/2; Time-weighted ≈ (1/T)∫e; Growth path accrued ≈ stock + F×min(Th,Tf). Match Analytics Exposure @ Δ1 (±5%).',
  varSetup:
    'In Analytics choose confidence (90/95/99), VaR analysis horizon (vol √T), and VaR profile (Simple / Time-weighted / Growth path). Set forecast period on FX Risk. Copy those into Your answers.',
  varAmt:
    'Enter EUR VaR at Δ = 1 ($K) that matches your Analytics setup (±5%). Read it from Risk Metrics / Analytics at Δ = 1 — not from a guessed template.',
  carryTf:
    'On Group FX → Analytics → Cash Carry set forecast period Tf to 12 months. Do-nothing carry is the unhedged Total / Do nothing column.',
  carryByCcy:
    'Read Do nothing carry @ 12m ($K) for EUR, GBP, PLN, MXN and JPY from Cash Carry · all currencies. Enter each in $K (±5%). Leave hedges off — this task scores the unhedged book.',
  carryTotal:
    'All CCY footer Σ is the sum of the five do-nothing carries at Tf = 12m. Enter it in $K (±5%).',
  carryEarn:
    'Largest EARN is the currency with the most positive Do nothing carry at 12m. Read the Cash Carry table — rate × growing cash can beat a higher-yield smaller pile.',
  carryPay:
    'Largest PAY is the currency with the most negative (or smallest) Do nothing carry at 12m — read the table, do not guess from the rate alone.',
} as const;

function profileHasRequiredInputs(inputs: FxInput[] | undefined): boolean {
  if (!inputs) return false;
  return TASK01_REQUIRED_FX_INPUTS.every(i => inputs.includes(i));
}

/** True when an entity has a dashboard with an FX Risk profile (local positions). */
export function entityHasLocalPositions(entity: Workspace['entities'][number]): boolean {
  return entity.dashboards.some(d =>
    d.riskProfiles.some(
      p => p.type === 'fx' && profileHasRequiredInputs(p.fxConfig?.inputs),
    ),
  );
}

/**
 * Group consolidated dashboard unlocks only after US · GmbH · Poland each have
 * a local dashboard + FX Risk profile (positions).
 */
export function localsReadyForConsolidation(workspace: Workspace): boolean {
  const byClass = {
    US: workspace.entities.find(e => classifyNordtechEntity(e) === 'US'),
    DE: workspace.entities.find(e => classifyNordtechEntity(e) === 'DE'),
    PL: workspace.entities.find(e => classifyNordtechEntity(e) === 'PL'),
  };
  return (['US', 'DE', 'PL'] as const).every(c => {
    const e = byClass[c];
    return !!e && entityHasLocalPositions(e);
  });
}

export function localReadinessByEntity(workspace: Workspace): {
  code: 'US' | 'DE' | 'PL';
  name: string;
  ready: boolean;
}[] {
  return (['US', 'DE', 'PL'] as const).map(code => {
    const e = workspace.entities.find(ent => classifyNordtechEntity(ent) === code);
    return {
      code,
      name: e?.name ?? `(missing ${code})`,
      ready: !!e && entityHasLocalPositions(e),
    };
  });
}

function profileHasRequiredDecisionLayers(
  layers: DecisionLayer[] | undefined,
): boolean {
  // Empty/missing fails — UI may still show tabs via defaults; persist via ensureTask01FxLayers.
  if (!layers?.length) return false;
  return TASK01_REQUIRED_DECISION_LAYERS.every(l => layers.includes(l));
}

function profileHasRequiredAnalyticalLayers(
  layers: AnalyticalLayer[] | undefined,
): boolean {
  if (!layers?.length) return false;
  return TASK01_REQUIRED_ANALYTICAL_LAYERS.every(l => layers.includes(l));
}

/**
 * Backfill Hedging + Risk Metrics on FX profiles when missing/empty.
 * Keeps Validate in sync with the Task 01 UI (which already falls back to these defaults).
 */
export function ensureTask01FxLayers(workspace: Workspace): Workspace {
  let changed = false;
  const entities = workspace.entities.map(e => ({
    ...e,
    dashboards: e.dashboards.map(d => ({
      ...d,
      riskProfiles: d.riskProfiles.map(p => {
        if (p.type !== 'fx' || !p.fxConfig) return p;
        const decisionLayers = p.fxConfig.decisionLayers?.length
          ? p.fxConfig.decisionLayers
          : ([...TASK01_REQUIRED_DECISION_LAYERS] as DecisionLayer[]);
        const analyticalLayers = p.fxConfig.analyticalLayers?.length
          ? p.fxConfig.analyticalLayers
          : ([...TASK01_REQUIRED_ANALYTICAL_LAYERS] as AnalyticalLayer[]);
        const inputs = p.fxConfig.inputs?.length
          ? p.fxConfig.inputs
          : ([...TASK01_REQUIRED_FX_INPUTS] as FxInput[]);
        if (
          decisionLayers === p.fxConfig.decisionLayers
          && analyticalLayers === p.fxConfig.analyticalLayers
          && inputs === p.fxConfig.inputs
        ) {
          return p;
        }
        changed = true;
        return {
          ...p,
          fxConfig: {
            ...p.fxConfig,
            inputs,
            decisionLayers,
            analyticalLayers,
          },
        };
      }),
    })),
  }));
  return changed ? { ...workspace, entities } : workspace;
}

function parseNum(raw: string): number | null {
  const cleaned = raw.replace(/[,$€£zł\s]/gi, '').replace(/m$/i, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate Task 01: workspace structure (entities → dashboards → FX profiles)
 * plus student answers vs the hidden NordTech reference (±5%).
 */
export function scoreTask01(
  workspace: Workspace,
  answers: TaskAnswers,
  groupDashboardOpened = false,
): TaskScoreResult {
  const checks: ScoreCheck[] = [];
  const hints: string[] = [];

  const classes = workspace.entities.map(classifyNordtechEntity);
  const hasUS = classes.includes('US');
  const hasDE = classes.includes('DE');
  const hasPL = classes.includes('PL');
  const entitiesOk = hasUS && hasDE && hasPL;
  checks.push({
    id: 'entities',
    label: 'Three NordTech entities (US · GmbH · Poland)',
    pass: entitiesOk,
    expected: 'NordTech US, GmbH, Poland',
    actual: workspace.entities.map(e => e.name ?? '(unnamed)').join(', ') || '(none)',
    hint: entitiesOk ? undefined : HINTS.entities,
  });

  checks.push({
    id: 'groupDashboard',
    label: 'Parent consolidated Group FX dashboard opened',
    pass: groupDashboardOpened,
    expected: 'Group FX opened',
    actual: groupDashboardOpened ? 'Opened' : 'Not opened yet',
    hint: groupDashboardOpened ? undefined : HINTS.group,
  });

  const byClass = {
    US: workspace.entities.find(e => classifyNordtechEntity(e) === 'US'),
    DE: workspace.entities.find(e => classifyNordtechEntity(e) === 'DE'),
    PL: workspace.entities.find(e => classifyNordtechEntity(e) === 'PL'),
  };

  const dashOk = (['US', 'DE', 'PL'] as const).every(c => {
    const e = byClass[c];
    return e && e.dashboards.length >= 1;
  });
  checks.push({
    id: 'dashboards',
    label: 'Dashboard created per entity',
    pass: !!dashOk,
    expected: '≥1 dashboard on US, GmbH, Poland',
    actual: (['US', 'DE', 'PL'] as const)
      .map(c => `${c}:${byClass[c]?.dashboards.length ?? 0}`)
      .join(' '),
    hint: dashOk ? undefined : HINTS.dashboards,
  });

  const profileOk = (['US', 'DE', 'PL'] as const).every(c => {
    const e = byClass[c];
    if (!e) return false;
    return e.dashboards.some(d => d.riskProfiles.some(p => p.type === 'fx'));
  });
  checks.push({
    id: 'fxProfiles',
    label: 'FX risk profile on each entity dashboard',
    pass: !!profileOk,
    expected: 'FX profile on each entity',
    actual: profileOk ? 'OK' : 'Missing FX profile on one or more entities',
    hint: profileOk ? undefined : HINTS.profiles,
  });

  const inputsOk = (['US', 'DE', 'PL'] as const).every(c => {
    const e = byClass[c];
    if (!e) return false;
    return e.dashboards.some(d =>
      d.riskProfiles.some(
        p => p.type === 'fx' && profileHasRequiredInputs(p.fxConfig?.inputs),
      ),
    );
  });
  checks.push({
    id: 'fxInputs',
    label: 'FX Risk input on each entity profile',
    pass: !!inputsOk,
    expected: TASK01_REQUIRED_FX_INPUTS.join(', '),
    actual: inputsOk ? 'OK' : 'Missing FX Risk (fxExposure)',
    hint: inputsOk ? undefined : HINTS.fxInputs,
  });

  const decisionOk = (['US', 'DE', 'PL'] as const).every(c => {
    const e = byClass[c];
    if (!e) return false;
    return e.dashboards.some(d =>
      d.riskProfiles.some(
        p =>
          p.type === 'fx' &&
          profileHasRequiredDecisionLayers(p.fxConfig?.decisionLayers),
      ),
    );
  });
  checks.push({
    id: 'decisionLayers',
    label: 'Decision layer: Hedging Decision',
    pass: !!decisionOk,
    expected: TASK01_REQUIRED_DECISION_LAYERS.join(', '),
    actual: decisionOk ? 'OK' : 'Missing Hedging Decision layer',
    hint: decisionOk ? undefined : HINTS.decisionLayers,
  });

  const analyticalOk = (['US', 'DE', 'PL'] as const).every(c => {
    const e = byClass[c];
    if (!e) return false;
    return e.dashboards.some(d =>
      d.riskProfiles.some(
        p =>
          p.type === 'fx' &&
          profileHasRequiredAnalyticalLayers(p.fxConfig?.analyticalLayers),
      ),
    );
  });
  checks.push({
    id: 'analyticalLayers',
    label: 'Analytical layer: Risk Metrics (VaR)',
    pass: !!analyticalOk,
    expected: TASK01_REQUIRED_ANALYTICAL_LAYERS.join(', '),
    actual: analyticalOk ? 'OK' : 'Missing Risk Metrics analytical layer',
    hint: analyticalOk ? undefined : HINTS.analyticalLayers,
  });

  const ccyRaw = answers.largestMismatchCcy.trim().toUpperCase();
  const ccyOk = ccyRaw === 'EUR';
  checks.push({
    id: 'answerCcy',
    label: 'Answer: largest mismatch currency',
    pass: ccyOk,
    expected: 'EUR',
    actual: ccyRaw || '(blank)',
    hint: ccyOk ? undefined : HINTS.mismatchCcy,
  });

  const setup = parseVarSetup(answers);
  const exposureBasis = setup?.exposureBasis ?? 'stock';
  const expectedExposureM = setup
    ? eurRefExposureM(setup)
    : eurRefExposureM({ exposureBasis: 'stock', forecastMonths: 1 });
  const amt = parseNum(answers.largestMismatchAmount);
  const amtOk =
    amt !== null && withinTolerance(amt, expectedExposureM);
  const basisLabel =
    exposureBasis === 'simpleAvg'
      ? 'simple average'
      : exposureBasis === 'avgBuildup'
        ? 'time-weighted average'
        : exposureBasis === 'totalBuildup'
          ? 'growth path average'
          : 'stock now';
  checks.push({
    id: 'answerAmount',
    label: `Answer: EUR ${basisLabel} (local M)`,
    pass: amtOk,
    expected: `+${expectedExposureM} (±5%) · ${basisLabel}`,
    actual: amt === null ? '(blank/invalid)' : `${amt}`,
    hint: amtOk ? undefined : HINTS.mismatchAmt,
  });

  const setupOk = setup !== null;
  checks.push({
    id: 'answerConfidence',
    label: 'Answer: Analytics VaR setup',
    pass: setupOk,
    expected: 'confidence · horizon · VaR profile',
    actual: setup
      ? setupLabel(setup)
      : [
          answers.varConfidencePct || '—',
          answers.varHorizon || '—',
          answers.varExposureBasis || '—',
        ].join(' / '),
    hint: setupOk ? undefined : HINTS.varSetup,
  });

  const varK = parseNum(answers.eurVarUsdK);
  const varUsdM =
    varK === null ? null : Math.abs(varK) >= 1 ? varK / 1000 : varK;
  const expectedVar = setup ? expectedEurVarUsdM(setup) : null;
  const varOk =
    varUsdM !== null
    && expectedVar !== null
    && withinTolerance(varUsdM, expectedVar);
  checks.push({
    id: 'answerVar',
    label: 'Answer: EUR VaR @ Δ=1 for your setup (USD)',
    pass: varOk,
    expected: expectedVar
      ? `~$${(expectedVar * 1000).toFixed(0)}K (±5%) · ${setupLabel(setup!)}`
      : 'Configure Analytics setup first',
    actual:
      varK === null
        ? '(blank/invalid)'
        : `$${Math.abs(varK) >= 1 ? varK.toFixed(0) : (varK * 1000).toFixed(0)}K`,
    hint: varOk ? undefined : HINTS.varAmt,
  });

  for (const c of checks) {
    if (!c.pass && c.hint) hints.push(c.hint);
  }

  const pass = checks.every(c => c.pass);
  return { pass, checks, hints: [...new Set(hints)] };
}

function nordtechSeedEntities(): Entity[] {
  return NORDTECH_ENTITIES.map(e => ({
    id: e.id,
    name: e.legalName,
    baseCurrency: e.functionalCurrency,
    description: e.description,
    createdAt: '',
    dashboards: [],
  }));
}

export interface Task02CarryReference {
  byCcy: Record<(typeof TASK02_CARRY_CCYS)[number], number>;
  allCcy: number;
  earnCcy: (typeof TASK02_CARRY_CCYS)[number];
  payCcy: (typeof TASK02_CARRY_CCYS)[number];
}

/**
 * Hidden Task 02 reference — unhedged do-nothing cash carry @ Tf = 12m
 * from the same Cash Carry engine the Analytics table uses (LP overnight).
 */
export function expectedTask02CarryUsdM(): Task02CarryReference {
  const entities = nordtechSeedEntities();
  const book = consolidateEntityBooks(entities, '02');
  const forecast = mergedEntityForecastProfile(entities, '02');
  const byCcy = {} as Task02CarryReference['byCcy'];
  for (const ccy of TASK02_CARRY_CCYS) {
    const cmp = buildCashForecastCarryComparison({
      ccy,
      bookRows: book.rows,
      forecastProfile: forecast,
      forecastMonths: TASK02_FORECAST_MONTHS,
      marketRates: emptyMarketRatesForCcy(ccy),
    });
    byCcy[ccy] = cmp?.categories.unhedgedIncomeUsdM ?? 0;
  }
  const allCcy = TASK02_CARRY_CCYS.reduce((sum, ccy) => sum + byCcy[ccy], 0);
  let earnCcy: (typeof TASK02_CARRY_CCYS)[number] = TASK02_CARRY_CCYS[0];
  let payCcy: (typeof TASK02_CARRY_CCYS)[number] = TASK02_CARRY_CCYS[0];
  for (const ccy of TASK02_CARRY_CCYS) {
    if (byCcy[ccy] > byCcy[earnCcy]) earnCcy = ccy;
    if (byCcy[ccy] < byCcy[payCcy]) payCcy = ccy;
  }
  return { byCcy, allCcy, earnCcy, payCcy };
}

function usdKFromAnswer(raw: string): number | null {
  const n = parseNum(raw);
  if (n === null) return null;
  // Students enter $K; accept a raw $M figure when |n| < 1.
  return Math.abs(n) >= 1 ? n / 1000 : n;
}

function scoreNordtechStructure(
  workspace: Workspace,
  groupDashboardOpened: boolean,
): { checks: ScoreCheck[]; hints: string[] } {
  const checks: ScoreCheck[] = [];
  const hints: string[] = [];

  const classes = workspace.entities.map(classifyNordtechEntity);
  const entitiesOk =
    classes.includes('US') && classes.includes('DE') && classes.includes('PL');
  checks.push({
    id: 'entities',
    label: 'Three NordTech entities (US · GmbH · Poland)',
    pass: entitiesOk,
    expected: 'NordTech US, GmbH, Poland',
    actual: workspace.entities.map(e => e.name ?? '(unnamed)').join(', ') || '(none)',
    hint: entitiesOk ? undefined : HINTS.entities,
  });

  checks.push({
    id: 'groupDashboard',
    label: 'Parent consolidated Group FX dashboard opened',
    pass: groupDashboardOpened,
    expected: 'Group FX opened',
    actual: groupDashboardOpened ? 'Opened' : 'Not opened yet',
    hint: groupDashboardOpened ? undefined : HINTS.group,
  });

  const byClass = {
    US: workspace.entities.find(e => classifyNordtechEntity(e) === 'US'),
    DE: workspace.entities.find(e => classifyNordtechEntity(e) === 'DE'),
    PL: workspace.entities.find(e => classifyNordtechEntity(e) === 'PL'),
  };

  const dashOk = (['US', 'DE', 'PL'] as const).every(c => {
    const e = byClass[c];
    return e && e.dashboards.length >= 1;
  });
  checks.push({
    id: 'dashboards',
    label: 'Dashboard created per entity',
    pass: !!dashOk,
    expected: '≥1 dashboard on US, GmbH, Poland',
    actual: (['US', 'DE', 'PL'] as const)
      .map(c => `${c}:${byClass[c]?.dashboards.length ?? 0}`)
      .join(' '),
    hint: dashOk ? undefined : HINTS.dashboards,
  });

  const profileOk = (['US', 'DE', 'PL'] as const).every(c => {
    const e = byClass[c];
    if (!e) return false;
    return e.dashboards.some(d => d.riskProfiles.some(p => p.type === 'fx'));
  });
  checks.push({
    id: 'fxProfiles',
    label: 'FX risk profile on each entity dashboard',
    pass: !!profileOk,
    expected: 'FX profile on each entity',
    actual: profileOk ? 'OK' : 'Missing FX profile on one or more entities',
    hint: profileOk ? undefined : HINTS.profiles,
  });

  const inputsOk = (['US', 'DE', 'PL'] as const).every(c => {
    const e = byClass[c];
    if (!e) return false;
    return e.dashboards.some(d =>
      d.riskProfiles.some(
        p => p.type === 'fx' && profileHasRequiredInputs(p.fxConfig?.inputs),
      ),
    );
  });
  checks.push({
    id: 'fxInputs',
    label: 'FX Risk input on each entity profile',
    pass: !!inputsOk,
    expected: TASK01_REQUIRED_FX_INPUTS.join(', '),
    actual: inputsOk ? 'OK' : 'Missing FX Risk (fxExposure)',
    hint: inputsOk ? undefined : HINTS.fxInputs,
  });

  const decisionOk = (['US', 'DE', 'PL'] as const).every(c => {
    const e = byClass[c];
    if (!e) return false;
    return e.dashboards.some(d =>
      d.riskProfiles.some(
        p =>
          p.type === 'fx' &&
          profileHasRequiredDecisionLayers(p.fxConfig?.decisionLayers),
      ),
    );
  });
  checks.push({
    id: 'decisionLayers',
    label: 'Decision layer: Hedging Decision',
    pass: !!decisionOk,
    expected: TASK01_REQUIRED_DECISION_LAYERS.join(', '),
    actual: decisionOk ? 'OK' : 'Missing Hedging Decision layer',
    hint: decisionOk ? undefined : HINTS.decisionLayers,
  });

  const analyticalOk = (['US', 'DE', 'PL'] as const).every(c => {
    const e = byClass[c];
    if (!e) return false;
    return e.dashboards.some(d =>
      d.riskProfiles.some(
        p =>
          p.type === 'fx' &&
          profileHasRequiredAnalyticalLayers(p.fxConfig?.analyticalLayers),
      ),
    );
  });
  checks.push({
    id: 'analyticalLayers',
    label: 'Analytical layer: Risk Metrics (VaR)',
    pass: !!analyticalOk,
    expected: TASK01_REQUIRED_ANALYTICAL_LAYERS.join(', '),
    actual: analyticalOk ? 'OK' : 'Missing Risk Metrics analytical layer',
    hint: analyticalOk ? undefined : HINTS.analyticalLayers,
  });

  for (const c of checks) {
    if (!c.pass && c.hint) hints.push(c.hint);
  }
  return { checks, hints };
}

/**
 * Validate Task 02: same NordTech workspace, then unhedged do-nothing
 * carry @ 12m for EUR · GBP · PLN · MXN · JPY (±5%).
 */
export function scoreTask02(
  workspace: Workspace,
  answers: TaskAnswers,
  groupDashboardOpened = false,
): TaskScoreResult {
  const structure = scoreNordtechStructure(workspace, groupDashboardOpened);
  const checks: ScoreCheck[] = [...structure.checks];
  const hints: string[] = [...structure.hints];
  const expected = expectedTask02CarryUsdM();

  const tf = parseNum(answers.carryForecastMonths ?? '');
  const tfOk = tf !== null && Math.abs(tf - TASK02_FORECAST_MONTHS) < 0.01;
  checks.push({
    id: 'carryTf',
    label: 'Answer: Cash Carry forecast period Tf',
    pass: tfOk,
    expected: `${TASK02_FORECAST_MONTHS} months`,
    actual: tf === null ? '(blank/invalid)' : `${tf}`,
    hint: tfOk ? undefined : HINTS.carryTf,
  });

  const carryFields: {
    id: string;
    ccy: (typeof TASK02_CARRY_CCYS)[number];
    raw: string;
  }[] = [
    { id: 'carryEur', ccy: 'EUR', raw: answers.carryEurUsdK ?? '' },
    { id: 'carryGbp', ccy: 'GBP', raw: answers.carryGbpUsdK ?? '' },
    { id: 'carryPln', ccy: 'PLN', raw: answers.carryPlnUsdK ?? '' },
    { id: 'carryMxn', ccy: 'MXN', raw: answers.carryMxnUsdK ?? '' },
    { id: 'carryJpy', ccy: 'JPY', raw: answers.carryJpyUsdK ?? '' },
  ];
  for (const field of carryFields) {
    const usdM = usdKFromAnswer(field.raw);
    const want = expected.byCcy[field.ccy];
    const ok = usdM !== null && withinTolerance(usdM, want);
    checks.push({
      id: field.id,
      label: `Answer: ${field.ccy} do-nothing carry @ 12m ($K)`,
      pass: ok,
      expected: `~$${(want * 1000).toFixed(1)}K (±5%)`,
      actual:
        usdM === null
          ? '(blank/invalid)'
          : `$${(usdM * 1000).toFixed(1)}K`,
      hint: ok ? undefined : HINTS.carryByCcy,
    });
  }

  const allM = usdKFromAnswer(answers.carryAllCcyUsdK ?? '');
  const allOk = allM !== null && withinTolerance(allM, expected.allCcy);
  checks.push({
    id: 'carryAll',
    label: 'Answer: All CCY do-nothing carry @ 12m ($K)',
    pass: allOk,
    expected: `~$${(expected.allCcy * 1000).toFixed(1)}K (±5%)`,
    actual:
      allM === null ? '(blank/invalid)' : `$${(allM * 1000).toFixed(1)}K`,
    hint: allOk ? undefined : HINTS.carryTotal,
  });

  const earn = (answers.carryEarnCcy ?? '').trim().toUpperCase();
  const earnOk = earn === expected.earnCcy;
  checks.push({
    id: 'carryEarn',
    label: 'Answer: largest EARN carry currency',
    pass: earnOk,
    expected: expected.earnCcy,
    actual: earn || '(blank)',
    hint: earnOk ? undefined : HINTS.carryEarn,
  });

  const pay = (answers.carryPayCcy ?? '').trim().toUpperCase();
  const payOk = pay === expected.payCcy;
  checks.push({
    id: 'carryPay',
    label: 'Answer: largest PAY carry currency',
    pass: payOk,
    expected: expected.payCcy,
    actual: pay || '(blank)',
    hint: payOk ? undefined : HINTS.carryPay,
  });

  for (const c of checks) {
    if (!c.pass && c.hint) hints.push(c.hint);
  }
  return { pass: checks.every(c => c.pass), checks, hints: [...new Set(hints)] };
}
