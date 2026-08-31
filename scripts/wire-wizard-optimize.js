const fs = require('fs');
const path = require('path');

const file = path.join(
  __dirname,
  '../components/test-mode/LiquidityAnalyticsView.tsx',
);
let src = fs.readFileSync(file, 'utf8');

// --- imports ---
if (!src.includes('LiquidityWizardPanels')) {
  src = src.replace(
    `import { LiquidityFrontierModal } from '@/components/test-mode/LiquidityFrontierModal';`,
    `import { LiquidityFrontierModal } from '@/components/test-mode/LiquidityFrontierModal';
import { PortfolioCarryVarFrontierPlot as OptimizeFrontierPlot } from '@/components/test-mode/PortfolioCarryVarFrontierPlot';
import {
  DetailMetrics,
  overlayVarRows,
  ParetoScenarioCard,
  SolutionCard,
  strategyTotalCarryUsdYrM,
  VarBudgetUsage,
  type FrontierSolutionCard,
  type OverlayContrib,
} from '@/components/test-mode/LiquidityWizardPanels';`,
  );
}

if (!src.includes('generateUsableParetoScenarios')) {
  src = src.replace(
    `from '@/lib/test-mode/portfolio-modal-align';`,
    `from '@/lib/test-mode/portfolio-modal-align';
import {
  generateUsableParetoScenarios,
  overlaySampleVars,
  type GeneratedParetoPick,
} from '@/lib/test-mode/portfolio-carry-scenarios';
import {
  priceOverlayFillCashSwapByCcy,
  priceOverlayFillCashSwapUsdYr,
} from '@/lib/test-mode/portfolio-liquidity-frontier';`,
  );
}

// --- state after wizardStep ---
if (!src.includes('const [optFor, setOptFor]')) {
  src = src.replace(
    `  const [wizardStep, setWizardStep] = useState(1);
  const [maxReached, setMaxReached] = useState(1);`,
    `  const [wizardStep, setWizardStep] = useState(1);
  const [maxReached, setMaxReached] = useState(1);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [optFor, setOptFor] = useState<'carry' | 'var' | 'efficiency'>('carry');
  const [tuneRatio, setTuneRatio] = useState<Record<string, number>>({});
  const [frontierCcy, setFrontierCcy] = useState<string | null>(null);`,
  );
}

// --- after mvFrontier block: add overlay/pareto wiring ---
const marker = `    portfolioIncludedCcys,
  ]);

  const selected =
    results.find(r => r.strategy.id === selectedId)`;

if (!src.includes('const paretoUniverse = useMemo')) {
  const insert = `    portfolioIncludedCcys,
  ]);

  const selected =
    results.find(r => r.strategy.id === selectedId)
    ?? results.find(r => r.strategy.id === liveStrategy.id)
    ?? results[0];

  const unconstrainedMv = mvFrontier;
  const allocRatio = useMemo(() => {
    const next: Record<string, number> = { ...tuneRatio };
    if (!unconstrainedMv) return next;
    for (const leg of unconstrainedMv.capLegs) {
      if (tuneRatio[leg.ccy] != null && Math.abs(tuneRatio[leg.ccy]! - 100) >= 0.5) continue;
      next[leg.ccy] = 100;
    }
    return next;
  }, [tuneRatio, unconstrainedMv]);

  const deskLiveOverlayFcy = useMemo(() => {
    if (!unconstrainedMv || !selected) return undefined;
    if (selected.strategy.id === liveStrategy.id) return undefined;
    if (!(activeLayers?.has('carryOptim') ?? false)) return undefined;
    return Object.fromEntries(unconstrainedMv.capLegs.map(l => [l.ccy, l.fcyM]));
  }, [unconstrainedMv, selected, liveStrategy.id, activeLayers]);

  const liveOverlayBook = useMemo((): OverlayContrib | null => {
    if (!mvFrontier || !unconstrainedMv || !selected) return null;
    const price = {
      result: selected,
      rows: (bookRows ?? []).filter(r => isPortfolioCcyIncluded(r.ccy)),
      engine: frontierEngineInput,
      liveOverlayFcyByCcy: deskLiveOverlayFcy,
    };
    const liveFcy = Object.fromEntries(mvFrontier.legs.map(l => [l.ccy, l.fcyM]));
    const capFcy = Object.fromEntries(unconstrainedMv.capLegs.map(l => [l.ccy, l.fcyM]));
    const liveCarryRows = priceOverlayFillCashSwapByCcy({ ...price, overlayFcyByCcy: liveFcy })
      .filter(r => Math.abs(r.usdM) > 0.00005)
      .sort((a, b) => Math.abs(b.usdM) - Math.abs(a.usdM));
    const capCarryRows = priceOverlayFillCashSwapByCcy({ ...price, overlayFcyByCcy: capFcy })
      .filter(r => Math.abs(r.usdM) > 0.00005)
      .sort((a, b) => Math.abs(b.usdM) - Math.abs(a.usdM));
    const liveVar = overlayVarRows(mvFrontier.legs);
    const capVar = overlayVarRows(unconstrainedMv.capLegs);
    return {
      portVarUsdM: mvFrontier.sweet.varUsdM,
      standaloneVarUsdM: liveVar.standaloneUsdM,
      liveVarRows: liveVar.rows,
      capVarRows: capVar.rows,
      liveCarryRows,
      capCarryRows,
      liveCarryUsdYrM: liveCarryRows.reduce((s, r) => s + r.usdM, 0),
    };
  }, [mvFrontier, unconstrainedMv, selected, bookRows, frontierEngineInput, deskLiveOverlayFcy, portfolioIncludedCcys]);

  const portFrontier = useMemo(() => {
    if (!selected || !(bookRows?.length)) return null;
    const overlayFcyByCcy = mvFrontier
      ? Object.fromEntries(
        (mvFrontier.legs.length > 0 ? mvFrontier.legs : mvFrontier.capLegs)
          .map(l => [l.ccy, l.fcyM]),
      )
      : undefined;
    return buildPortfolioLiquidityFrontier({
      result: selected,
      strategy: selected.strategy,
      rows: bookRows.filter(r => isPortfolioCcyIncluded(r.ccy)),
      engine: frontierEngineInput,
      overlayFcyByCcy,
      overlaySweetT: mvFrontier?.sweet.t,
    });
  }, [selected, bookRows, frontierEngineInput, mvFrontier, portfolioIncludedCcys]);

  const policyUsdM = policyVAR ?? 5;
  const scenarioBudgetUsdM = policyUsdM;
  const paretoUniverse = useMemo((): {
    cards: FrontierSolutionCard[];
    bookFront: { x: number; y: number }[];
  } => {
    const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
    const askK = portfolioCarryK;
    const mixOf = (legs: { ccy: string; usdM: number }[]) => {
      const weights = l1Weights(legs.map(l => l.usdM));
      return legs
        .map((l, i) => ({ ccy: l.ccy, w: weights[i]! }))
        .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
        .slice(0, 3)
        .map(l => \`\${l.ccy} \${(l.w * 100).toFixed(0)}%\`)
        .join(' · ');
    };
    const priceOverlay = (
      overlayFcyByCcy: Record<string, number>,
      overlayVarUsdM: number,
      mix: string,
    ) => {
      if (!selected) return null;
      const bookCarryUsdYrM = priceOverlayFillCashSwapUsdYr({
        result: selected,
        rows: (bookRows ?? []).filter(r => isPortfolioCcyIncluded(r.ccy)),
        engine: frontierEngineInput,
        overlayFcyByCcy,
        liveOverlayFcyByCcy: deskLiveOverlayFcy,
      });
      return { overlayVarUsdM, bookCarryUsdYrM, mix };
    };
    const priceAtVar = (varCapUsdM: number) => {
      if (!mvFrontier || !selected) return null;
      // Reprice at an alternate VAR cap with the same μ / bases as the live frontier.
      const rows = (bookRows ?? [])
        .filter(r => r.ccy !== 'USD' && CURRENCY_PARAMS[r.ccy] && isPortfolioCcyIncluded(r.ccy));
      if (rows.length < 1) return null;
      const rUsdLocal = input.shared.r_USD;
      const bookingMode = timing.bookingMode ?? 'rolling';
      const tenorMonths = bookingMode === 'rolling'
        ? 1
        : Math.max(1, input.shared.forecastMonths ?? months);
      const alloc = buildEfficientCarryVarFrontier({
        ccys: rows.map(r => r.ccy),
        mu: rows.map(r => (
          impliedPortfolioRFcyPct(r.ccy, r.r_FCY, rUsdLocal, marketRatesByCcy, tenorMonths) - rUsdLocal
        ) / 100),
        varCapUsdM,
        carryTargetUsdYrM: undefined,
        basesFcy: rows.map(r => Math.max(r.cash + r.payout, 0)),
        rOd: rows.map(r => r.r_OD),
        r_USD: rUsdLocal,
        fixedCfarUsdM: activeLayers?.has('cfarCover')
          ? rows.map(r => Math.abs(cfarNetByCcyUsd?.[r.ccy] ?? 0))
          : undefined,
      });
      if (!alloc) return null;
      const overlayFcyByCcy = Object.fromEntries(alloc.capLegs.map(l => [l.ccy, l.fcyM]));
      return priceOverlay(overlayFcyByCcy, alloc.cap.varUsdM, mixOf(alloc.capLegs));
    };
    const samples = overlaySampleVars(universeFrontier, scenarioBudgetUsdM)
      .map(v => priceAtVar(v))
      .filter((row): row is NonNullable<ReturnType<typeof priceAtVar>> => row != null);
    if (askK != null && Number.isFinite(askK) && askK > 0 && selected) {
      const rows = (bookRows ?? [])
        .filter(r => r.ccy !== 'USD' && CURRENCY_PARAMS[r.ccy] && isPortfolioCcyIncluded(r.ccy));
      if (rows.length >= 1) {
        const rUsdLocal = input.shared.r_USD;
        const bookingMode = timing.bookingMode ?? 'rolling';
        const tenorMonths = bookingMode === 'rolling'
          ? 1
          : Math.max(1, input.shared.forecastMonths ?? months);
        const hit = buildEfficientCarryVarFrontier({
          ccys: rows.map(r => r.ccy),
          mu: rows.map(r => (
            impliedPortfolioRFcyPct(r.ccy, r.r_FCY, rUsdLocal, marketRatesByCcy, tenorMonths) - rUsdLocal
          ) / 100),
          varCapUsdM: maxTier,
          carryTargetUsdYrM: askK / 1000,
          basesFcy: rows.map(r => Math.max(r.cash + r.payout, 0)),
          rOd: rows.map(r => r.r_OD),
          r_USD: rUsdLocal,
          fixedCfarUsdM: activeLayers?.has('cfarCover')
            ? rows.map(r => Math.abs(cfarNetByCcyUsd?.[r.ccy] ?? 0))
            : undefined,
        });
        if (hit) {
          const overlayFcyByCcy = Object.fromEntries(hit.legs.map(l => [l.ccy, l.fcyM]));
          const priced = priceOverlay(overlayFcyByCcy, hit.sweet.varUsdM, mixOf(hit.legs));
          if (priced) samples.push(priced);
        }
      }
    }
    const picks = generateUsableParetoScenarios({
      samples,
      budgetUsdM: scenarioBudgetUsdM,
      carryTargetUsdYrM: askK != null && Number.isFinite(askK) ? askK / 1000 : undefined,
      confidencePct: setup.confidencePct,
    });
    const toCard = (p: GeneratedParetoPick): FrontierSolutionCard => ({
      id: p.id,
      name: p.label,
      short: p.disabled
        ? (p.disabledHint ?? 'not on this front')
        : \`\${p.mix || p.short} · Pareto book\`,
      rationale: p.rationale,
      carryUsdYrM: p.bookCarryUsdYrM,
      riskUsdM: p.overlayVarUsdM,
      usedPct: maxTier > 0 ? (p.overlayVarUsdM / maxTier) * 100 : 0,
      efficiency: p.overlayVarUsdM > 1e-9 ? (p.bookCarryUsdYrM * 1000) / p.overlayVarUsdM : 0,
      approved: !p.disabled && p.overlayVarUsdM <= scenarioBudgetUsdM + 0.05,
      disabled: p.disabled,
    });
    const bookFront = [...samples]
      .sort((a, b) => a.overlayVarUsdM - b.overlayVarUsdM)
      .map(s => ({ x: s.overlayVarUsdM, y: s.bookCarryUsdYrM }));
    return { cards: picks.map(toCard), bookFront };
  }, [
    universeFrontier,
    scenarioBudgetUsdM,
    setup.confidencePct,
    portfolioCarryK,
    mvFrontier,
    selected,
    deskLiveOverlayFcy,
    bookRows,
    frontierEngineInput,
    input.shared.r_USD,
    input.shared.forecastMonths,
    timing.bookingMode,
    months,
    marketRatesByCcy,
    activeLayers,
    cfarNetByCcyUsd,
    portfolioIncludedCcys,
  ]);
  const shownPareto = paretoUniverse.cards;
  const paretoSelected = shownPareto.find(s => s.id === portfolioScenarioId) ?? null;

  const applyParetoCard = (id: PortfolioScenarioId) => {
    const card = shownPareto.find(s => s.id === id);
    if (!card || card.disabled || !(card.riskUsdM > 0)) return;
    const v = roundPolicyVar(card.riskUsdM);
    scenarioPolicyRef.current = v;
    scenarioPolicySyncedRef.current = false;
    setPortfolioScenarioId(id);
    setTuneRatio({});
    onPolicyVARChange?.(v);
    onPortfolioCarryKChange?.(undefined);
    if (onLayerToggle && !(activeLayers?.has('carryOptim') ?? false)) {
      onLayerToggle('carryOptim');
    }
  };

  const pickOptFor = (next: typeof optFor) => {
    setOptFor(next);
    const prefer: PortfolioScenarioId =
      next === 'var' ? 'conservative' : next === 'efficiency' ? 'maxReturn' : 'maxCarry';
    applyParetoCard(prefer);
  };

  const liveVarUsdM = liveOverlayBook?.portVarUsdM ?? paretoSelected?.riskUsdM ?? policyUsdM;
  const liveCarryUsdYrM = liveOverlayBook?.liveCarryUsdYrM
    ?? paretoSelected?.carryUsdYrM
    ?? (selected ? strategyTotalCarryUsdYrM(selected) : 0);
  const overBudget = liveVarUsdM > policyUsdM + 1e-9;
  const toggleFrontier = (ccy: string) => {
    setFrontierCcy(prev => (prev === ccy ? null : ccy));
    setInspectCcy(ccy);
  };

  const unfunded = results.find(r => r.strategy.id === 'unfunded');
  const inspectRow = inspectCcy
    ? bookRows?.find(r => r.ccy === inspectCcy)
    : undefined;

  // --- early-return gate uses selected below ---
  if (false as boolean) {
  const _dead =
    results.find(r => r.strategy.id === selectedId)`;

  if (!src.includes(marker)) {
    console.error('marker for selected not found');
    process.exit(1);
  }
  src = src.replace(marker, insert);
}

// --- replace wizard steps 4 and 5 ---
const step4Start = '      {wizardStep === 4 && (\n      <RegimeSummaryTable';
const step5End = '      )}\n\n      {inspectRow && (';

const stepIdx = src.indexOf(step4Start);
const endIdx = src.indexOf(step5End);
if (stepIdx < 0 || endIdx < 0) {
  console.error('steps markers not found', stepIdx, endIdx);
  process.exit(1);
}

const newSteps = `      {wizardStep === 4 && (
        <section className="space-y-4">
          <section className="rounded-2xl border border-slate-700 bg-slate-950/40 p-5">
            <div className="mb-4 flex flex-wrap items-baseline gap-2.5">
              <h2 className="text-base font-medium text-slate-100">Funding regime</h2>
              <span className="text-[11px] text-slate-500">
                Pick how the trough is booked. Next step prices exact cover options on this regime.
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {results.map(r => (
                <SolutionCard
                  key={r.strategy.id}
                  result={r}
                  confidencePct={setup.confidencePct}
                  isLive={r.strategy.id === liveStrategy.id}
                  isSelected={r.strategy.id === selected.strategy.id}
                  onSelect={() => setSelectedId(r.strategy.id)}
                />
              ))}
            </div>
          </section>
          <RegimeSummaryTable
            results={results}
            liveId={liveStrategy.id}
            selectedId={selected.strategy.id}
            confidencePct={setup.confidencePct}
            constraintHue={constraintHue}
            bookRows={bookRows ?? []}
            frontierEngine={frontierEngineInput}
            onSelect={setSelectedId}
            portfolioLevel={bufferLevelOf(activeLayers) === 'portfolio'}
            carryOn={activeLayers?.has('carryOptim') === true}
            mvFrontier={mvFrontier}
            overlayScenarioLabel={activeScenarioLabel}
            universeFrontier={universeFrontier}
            policyVAR={policyVAR ?? 5}
            portfolioScenarioId={portfolioScenarioId}
            conservativePoint={conservativePoint}
            unhedgedOriginUsdM={unhedgedOriginUsdM}
            portfolioPlotCfarUsdM={portfolioPlotCfarUsdM}
            onApplyScenario={applyPortfolioScenario}
            onPickCustom={applyCustomFrontierPoint}
            portfolioIncludedCcys={portfolioIncludedCcys}
            onTogglePortfolioCcy={togglePortfolioCcy}
            onSoloPortfolioCcy={soloPortfolioCcy}
            onResetPortfolioCcys={resetPortfolioCcys}
          />
        </section>
      )}

      {wizardStep === 5 && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <section className="flex flex-col gap-3.5 rounded-2xl border border-slate-700 bg-slate-950/40 p-5">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-medium text-slate-100">Solutions</h2>
              <span className="font-mono text-[11px] text-slate-500">
                Pareto optima on this strip
              </span>
            </div>
            <div className="flex flex-col gap-3">
              {shownPareto.map(s => (
                <ParetoScenarioCard
                  key={s.id}
                  scenario={s}
                  maxAbsCarryUsdYrM={Math.max(
                    ...shownPareto.map(p => Math.abs(p.carryUsdYrM)),
                    1e-9,
                  )}
                  isSelected={s.id === paretoSelected?.id}
                  onSelect={() => applyParetoCard(s.id)}
                />
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-6 rounded-2xl border border-slate-700 bg-slate-950/40 p-5">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-[13px] font-medium text-slate-200">Selected currencies</span>
                <div className="flex flex-wrap gap-1.5">
                  {portfolioEligibleCcys.map(ccy => {
                    const on = isPortfolioCcyIncluded(ccy);
                    return (
                      <button
                        key={ccy}
                        type="button"
                        onClick={() => togglePortfolioCcy(ccy)}
                        aria-pressed={on}
                        className={\`h-7 rounded-full border px-3 font-mono text-[12px] font-medium \${
                          on
                            ? 'border-sky-400/70 bg-sky-500/20 text-sky-100'
                            : 'border-slate-700 bg-slate-950/70 text-slate-400 hover:border-slate-500'
                        }\`}
                      >
                        {ccy}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-[13px] font-medium text-slate-200">Optimize for</span>
                {([
                  { id: 'carry', label: 'Carry' },
                  { id: 'var', label: 'VAR' },
                  { id: 'efficiency', label: 'Efficiency' },
                ] as const).map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => pickOptFor(opt.id)}
                    aria-pressed={optFor === opt.id}
                    className={\`h-7 rounded-full border px-3 text-[12px] font-medium \${
                      optFor === opt.id
                        ? 'border-sky-400/70 bg-sky-500/20 text-sky-100'
                        : 'border-slate-700 bg-slate-950/70 text-slate-400 hover:border-slate-500'
                    }\`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-base font-medium text-slate-100">
                {paretoSelected?.name ?? selected.strategy.label}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                {paretoSelected?.rationale ?? selected.strategy.tradeoff}
              </p>
            </div>

            <div
              className={\`flex items-start gap-3 rounded-xl border px-4 py-3 \${
                overBudget
                  ? 'border-amber-500/40 bg-amber-500/10'
                  : 'border-emerald-500/30 bg-emerald-500/10'
              }\`}
            >
              <div>
                <div className={\`text-[13px] font-medium \${overBudget ? 'text-amber-200' : 'text-emerald-200'}\`}>
                  {overBudget ? 'Exceeds the VAR budget' : 'Within policy — approved'}
                </div>
                <div className="mt-0.5 text-[12px] text-slate-400">
                  {paretoSelected?.name ?? selected.strategy.label}
                  {' · '}Overlay VAR $\{liveVarUsdM.toFixed(1)}M{' '}
                  {overBudget ? 'sits above' : 'clears'} the $\{policyUsdM.toFixed(0)}M budget.
                  {' '}Carry {fmtK(liveCarryUsdYrM)}
                  {portfolioCarryK != null && (
                    <> vs target {fmtK(portfolioCarryK / 1000)}.</>
                  )}
                </div>
              </div>
            </div>

            <DetailMetrics
              result={selected}
              confidencePct={setup.confidencePct}
              port={portFrontier}
              scenario={
                liveOverlayBook
                  ? {
                      name: paretoSelected?.name ?? 'Σ⁻¹μ overlay',
                      carryUsdYrM: liveOverlayBook.liveCarryUsdYrM,
                      riskUsdM: liveOverlayBook.portVarUsdM,
                    }
                  : paretoSelected
              }
            />

            <div>
              <div className="mb-3 flex flex-wrap items-baseline gap-2.5">
                <h3 className="text-base font-medium text-slate-100">Carry vs Policy VAR</h3>
                <span className="text-[11px] text-slate-500">Generated from the non-dominated front</span>
              </div>
              {universeFrontier ? (
                <OptimizeFrontierPlot
                  frontier={universeFrontier}
                  policyVAR={policyUsdM}
                  confidencePct={setup.confidencePct}
                  selectedScenarioId={portfolioScenarioId}
                  bookFront={paretoUniverse.bookFront}
                  picks={shownPareto
                    .filter(s => !s.disabled && s.riskUsdM > 0)
                    .map(s => ({
                      id: s.id,
                      overlayVarUsdM: s.riskUsdM,
                      bookCarryUsdYrM: s.carryUsdYrM,
                      label: s.name,
                    }))}
                  onApplyScenario={(id) => applyParetoCard(id)}
                  onUseBalanced={() => applyParetoCard('balanced')}
                />
              ) : (
                <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/40 px-4 py-8 text-center text-[11px] text-slate-500">
                  Turn on Portfolio buffer and include at least one FCY to trace the overlay curve.
                </div>
              )}
            </div>

            <VarBudgetUsage
              result={selected}
              port={portFrontier}
              budgetUsdM={policyUsdM}
              openCcy={frontierCcy}
              onOpenCcy={toggleFrontier}
              overlay={liveOverlayBook}
              tuneRatio={allocRatio}
              onSetRatio={(ccy, ratio) => setTuneRatio({ ...tuneRatio, [ccy]: ratio })}
            />

            <button
              type="button"
              onClick={() => setBreakdownOpen(o => !o)}
              className="self-start text-[13px] font-medium text-sky-300 hover:text-sky-200"
            >
              {breakdownOpen ? '▾' : '▸'} Per-currency breakdown ({selected.byCcy.length})
            </button>
            {breakdownOpen && (
              <SelectedStrategyDetail
                result={selected}
                isLive={isLive}
                onInspectCcy={setInspectCcy}
                residualByCcy={residualByCcy}
                onResidualChange={setCcyResidual}
                preparedByCcy={preparedByCcy}
                overlayLegs={portfolioLevel && carryOn ? mvFrontier?.legs : undefined}
                onStage={onPreparedByCcyChange ? stageFundingStrip : undefined}
                onStageAll={onPreparedByCcyChange ? stageAllFundingStrips : undefined}
                onResetDesk={resetDeskPrograms}
                onApplyPortfolioDelta={portfolioLevel ? applyPortfolioDelta : undefined}
                canApplyPortfolioDelta={
                  portfolioLevel && lastMixResidual != null
                }
              />
            )}
          </section>
        </div>
      )}

      {inspectRow && (`;

src = src.slice(0, stepIdx) + newSteps + src.slice(endIdx + '      )}\n\n      {inspectRow && ('.length);

fs.writeFileSync(file, src);
console.log('patched LiquidityAnalyticsView', src.length);
