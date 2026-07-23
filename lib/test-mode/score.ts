import {
  NORDTECH_REFERENCE,
  withinTolerance,
} from '@/lib/test-mode/fixtures/nordtech-reference';
import {
  classifyNordtechEntity,
  TASK01_REQUIRED_ANALYTICAL_LAYERS,
  TASK01_REQUIRED_DECISION_LAYERS,
  TASK01_REQUIRED_FX_INPUTS,
} from '@/lib/test-mode/nordtech-sim-seed';
import type {
  ScoreCheck,
  TaskAnswers,
  TaskScoreResult,
} from '@/lib/test-mode/types';
import {
  expectedEurVarUsdM,
  parseVarSetup,
  setupLabel,
} from '@/lib/test-mode/var-setup';
import type {
  AnalyticalLayer,
  DecisionLayer,
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
    'Largest stock mismatch is EUR long (Frankfurt cash + EU receivables). Enter currency code EUR.',
  mismatchAmt:
    'EUR stock net should be about +€4.9M (±5%) = Cash FX 2.5 + rReceivables 2.4.',
  varSetup:
    'In Analytics choose confidence (90/95/99), horizon (1w/1m/3m/6m/1y), and exposure (Stock now or Avg monthly buildup). Copy those into Your answers.',
  varAmt:
    'Enter EUR VaR at Δ = 1 ($K) that matches your Analytics setup (±5%). Example: stock · 1m · 99% ≈ $285K; avg buildup · 1m · 99% ≈ $390K.',
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
  return changed ? { entities } : workspace;
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

  const amt = parseNum(answers.largestMismatchAmount);
  const amtOk =
    amt !== null && withinTolerance(amt, NORDTECH_REFERENCE.eurStockNetM);
  checks.push({
    id: 'answerAmount',
    label: 'Answer: EUR stock net (local M)',
    pass: amtOk,
    expected: `+${NORDTECH_REFERENCE.eurStockNetM} (±5%)`,
    actual: amt === null ? '(blank/invalid)' : `${amt}`,
    hint: amtOk ? undefined : HINTS.mismatchAmt,
  });

  const setup = parseVarSetup(answers);
  const setupOk = setup !== null;
  checks.push({
    id: 'answerConfidence',
    label: 'Answer: Analytics VaR setup',
    pass: setupOk,
    expected: 'confidence · horizon · exposure basis',
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
