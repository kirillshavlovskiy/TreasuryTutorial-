'use client';

import {
  FORECAST_ACCURACY_LAYERS,
  POLICY_VAR_LIMITS,
  bufferLevelOf,
  setBufferLevel,
  toggleLayerGroup,
  type BufferChipKey,
  type LayerId,
} from '@/lib/fx-buffer';
import { VAR_CONFIDENCE_OPTIONS, type VarConfidencePct } from '@/lib/test-mode/var-confidence';

const BUFFER_LAYERS: readonly {
  id: BufferChipKey;
  layers: readonly LayerId[];
  label: string;
  dial: string;
  hint: string;
  settingsLabel: string;
  onClass: string;
  onDot: string;
  onDial: string;
  gearOn: string;
  gearBorder: string;
}[] = [
  {
    id: 'floorH',
    layers: ['floorH'],
    label: 'Min floor',
    dial: 'Min floor',
    hint: 'Hard minimum cash per currency',
    settingsLabel: 'Minimum liquidity buffer per currency — hard cash floor (M FCY)',
    onClass: 'border-amber-400/45 bg-amber-500/15 text-amber-200',
    onDot: 'bg-amber-300',
    onDial: 'border-amber-400/45 text-slate-400',
    gearOn: 'bg-amber-500/30 text-amber-100',
    gearBorder: 'border-amber-400/45',
  },
  {
    id: 'forecastAccuracy',
    layers: FORECAST_ACCURACY_LAYERS,
    label: 'Forecast accuracy',
    dial: 'σ buffer',
    hint: 'Payout-σ safety margin on FCY cash — FX Net CFaR is a readout, not Swap Near',
    settingsLabel: 'Forecast accuracy — payout σ and Net CFaR cover per currency',
    onClass: 'border-sky-400/45 bg-sky-500/15 text-sky-200',
    onDot: 'bg-sky-300',
    onDial: 'border-sky-400/45 text-slate-400',
    gearOn: 'bg-sky-500/30 text-sky-100',
    gearBorder: 'border-sky-400/45',
  },
  {
    id: 'carryOptim',
    layers: ['carryOptim'],
    label: 'Buffer Carry target',
    dial: 'Target Carry',
    hint: 'Apply the rate-driven buffer target',
    settingsLabel: 'Buffer Carry target — standing-swap cash Δr ask, r_OD and Δr per currency',
    onClass: 'border-emerald-400/45 bg-emerald-500/15 text-emerald-200',
    onDot: 'bg-emerald-300',
    onDial: 'border-emerald-400/45 text-slate-400',
    gearOn: 'bg-emerald-500/30 text-emerald-100',
    gearBorder: 'border-emerald-400/45',
  },
  {
    id: 'portfolioDiv',
    layers: ['portfolioDiv'],
    label: 'Portfolio VAR',
    dial: 'Target VAR',
    hint: 'Cross-currency mix: Σ⁻¹μ overlay under the shared Policy VAR cap',
    settingsLabel: 'Policy VAR limit — pick the overlay VAR cap (Treasury $5M / Director $10M / CFO $20M)',
    onClass: 'border-violet-400/45 bg-violet-500/15 text-violet-200',
    onDot: 'bg-violet-300',
    onDial: 'border-violet-400/45 text-slate-400',
    gearOn: 'bg-violet-500/30 text-violet-100',
    gearBorder: 'border-violet-400/45',
  },
];

function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.6.9 1.01 1.55 1.01H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </svg>
  );
}

/** Shared Confidence / Buffer regime / Policy VAR chips — Liquidity Policy and FX Risk setup. */
export function PolicySetupBlock({
  confidencePct,
  onConfidenceChange,
  activeLayers,
  onLayerToggle,
  layerPanel,
  onLayerPanelChange,
  policyVAR,
  onPolicyVARChange,
}: {
  confidencePct: VarConfidencePct;
  onConfidenceChange?: (pct: VarConfidencePct) => void;
  activeLayers?: Set<LayerId>;
  onLayerToggle?: (id: LayerId) => void;
  layerPanel?: BufferChipKey | null;
  onLayerPanelChange?: (id: BufferChipKey | null) => void;
  policyVAR?: number;
  onPolicyVARChange?: (usdM: number) => void;
}) {
  return (
    <div className="rounded-[10px] border border-slate-800 bg-slate-950/50 px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-400">
            Confidence
          </div>
          <div
            className="inline-flex rounded-md border border-slate-700 bg-slate-950 p-0.5"
            role="group"
            aria-label="Confidence level"
          >
            {VAR_CONFIDENCE_OPTIONS.map(opt => {
              const on = confidencePct === opt.pct;
              return (
                <button
                  key={opt.pct}
                  type="button"
                  title={`z = ${opt.z} · CFaR tail ${(100 - opt.pct).toFixed(0)}%`}
                  disabled={!onConfidenceChange}
                  onClick={() => onConfidenceChange?.(opt.pct)}
                  className={`rounded px-3 py-1 font-mono text-[11px] font-semibold transition-colors ${
                    on
                      ? 'bg-blue-500/25 text-blue-100'
                      : 'text-slate-500 hover:text-slate-300'
                  } ${onConfidenceChange ? '' : 'cursor-default opacity-80'}`}
                >
                  {opt.pct}
                </button>
              );
            })}
          </div>
        </div>
        <div className="min-w-0 border-slate-800 md:border-l md:pl-6">
          <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-400">
            Buffer regime
          </div>

          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <div
              className="inline-flex rounded-md border border-slate-700 bg-slate-950 p-0.5"
              role="group"
              aria-label="Buffer level"
            >
              {(['currency', 'portfolio'] as const).map(level => {
                const on = bufferLevelOf(activeLayers) === level;
                return (
                  <button
                    key={level}
                    type="button"
                    disabled={!onLayerToggle}
                    aria-pressed={on}
                    onClick={() => {
                      if (!onLayerToggle) return;
                      setBufferLevel(activeLayers, level, onLayerToggle);
                      if (level === 'currency' && layerPanel === 'portfolioDiv') {
                        onLayerPanelChange?.(null);
                      }
                    }}
                    title={
                      level === 'portfolio'
                        ? 'Same chips, book mix: Σ⁻¹μ overlay · Policy VAR + USD budget'
                        : 'Same chips, each currency on its own floor / σ / carry ask'
                    }
                    className={`rounded px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors ${
                      on
                        ? 'bg-violet-500/25 text-violet-100'
                        : 'text-slate-500 hover:text-slate-300'
                    } ${onLayerToggle ? '' : 'cursor-default opacity-80'}`}
                  >
                    {level === 'currency' ? 'Currency' : 'Portfolio'}
                  </button>
                );
              })}
            </div>
            {bufferLevelOf(activeLayers) === 'portfolio' && (
              <div
                className="inline-flex rounded-md border border-violet-400/45 bg-slate-950 p-0.5"
                role="group"
                aria-label="Policy VAR"
              >
                {POLICY_VAR_LIMITS.map(pl => {
                  const on = (policyVAR ?? 5) === pl.usd;
                  return (
                    <button
                      key={pl.usd}
                      type="button"
                      disabled={!onPolicyVARChange}
                      title={`${pl.label} · ${pl.who} approval`}
                      onClick={() => onPolicyVARChange?.(pl.usd)}
                      className={`rounded px-2 py-1 font-mono text-[11px] font-semibold transition-colors ${
                        on
                          ? 'bg-violet-500/25 text-violet-100'
                          : 'text-slate-500 hover:text-slate-300'
                      } ${onPolicyVARChange ? '' : 'cursor-default opacity-80'}`}
                    >
                      {pl.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {BUFFER_LAYERS.map(layer => {
              const active = layer.layers.some(id => activeLayers?.has(id) ?? false);
              const panelOpen = layerPanel === layer.id;
              return (
                <span
                  key={layer.id}
                  className={`inline-flex items-stretch overflow-hidden rounded-md border transition ${
                    active
                      ? layer.onClass
                      : 'border-slate-700 bg-slate-950/60 text-slate-500'
                  }`}
                >
                  <button
                    type="button"
                    disabled={!onLayerToggle}
                    aria-pressed={active}
                    onClick={() => {
                      if (!onLayerToggle) return;
                      toggleLayerGroup(layer.layers, activeLayers, onLayerToggle);
                      if (active && panelOpen) onLayerPanelChange?.(null);
                    }}
                    title={`${layer.hint}${onLayerToggle ? '' : ' · controlled from the Liquidity tab'}`}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold transition ${
                      active ? '' : 'hover:text-slate-300'
                    } disabled:cursor-default disabled:opacity-70`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        active ? layer.onDot : 'bg-slate-700'
                      }`}
                    />
                    {layer.label}
                    {layer.dial !== layer.label && (
                      <span
                        className={`border-l pl-1.5 font-mono text-[8px] tracking-wide ${
                          active ? layer.onDial : 'border-slate-700 text-slate-600'
                        }`}
                      >
                        {layer.dial}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={!onLayerPanelChange}
                    aria-pressed={panelOpen}
                    aria-label={layer.settingsLabel}
                    title={
                      onLayerPanelChange
                        ? layer.settingsLabel
                        : `${layer.settingsLabel} · open from the Liquidity tab`
                    }
                    onClick={() => {
                      if (!onLayerPanelChange) return;
                      onLayerPanelChange(panelOpen ? null : layer.id);
                    }}
                    className={`inline-flex items-center border-l px-1.5 transition-colors disabled:cursor-default disabled:opacity-70 ${
                      active ? layer.gearBorder : 'border-slate-700'
                    } ${
                      panelOpen
                        ? layer.gearOn
                        : 'text-slate-500 hover:text-slate-200'
                    }`}
                  >
                    <GearIcon className="h-3.5 w-3.5" />
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
