'use client';

import { useMemo, useState } from 'react';
import { fcyToUsdM, type RowState } from '@/lib/fx-buffer';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  bookedNotionalLocalM,
  buildHedgeVarSummary,
  type HedgeTicket,
  type HedgeVarRow,
} from '@/lib/test-mode/hedge-var';
import { DEFAULT_VAR_SETUP, type VarSetup } from '@/lib/test-mode/var-setup';

export type LadderPerspective = 'fxRisk' | 'cashCarry' | 'dv01' | 'greeks';

const PERSPECTIVES: {
  id: LadderPerspective;
  label: string;
  active: boolean;
  description: string;
  yLabel: string;
}[] = [
  {
    id: 'fxRisk',
    label: 'FX Risk',
    active: true,
    description:
      'Original exposure sources vs booked / proposed hedge structure. Residual tick = after hedges.',
    yLabel: 'Exposure (M)',
  },
  {
    id: 'cashCarry',
    label: 'Cash Carry',
    active: false,
    description: 'Carry / translation remeasurement by source (preview).',
    yLabel: 'Carry / mo (M)',
  },
  {
    id: 'dv01',
    label: 'DV01',
    active: false,
    description: 'Rate sensitivity stack on debt / investments (preview).',
    yLabel: 'DV01 / bp (M)',
  },
  {
    id: 'greeks',
    label: 'Greeks',
    active: false,
    description: 'δ-effective stack vs hedge overlay (preview).',
    yLabel: 'δ-notional (M)',
  },
];

const SEG_META = {
  cashFx: { label: 'Cash FX', color: '#0ea5e9' },
  nca: { label: 'rReceivables', color: '#8b5cf6' },
  liability: { label: 'Liability', color: '#f43f5e' },
  debt: { label: 'Debt', color: '#d97706' },
  invest: { label: 'Investments', color: '#14b8a6' },
  carry: { label: 'Cash Carry', color: '#fbbf24' },
  dv01Debt: { label: 'Debt DV01', color: '#f97316' },
  dv01Invest: { label: 'Invest DV01', color: '#22d3ee' },
  greeksSpot: { label: 'Spot δ', color: '#e879f9' },
  hedge: { label: 'Hedge (Decision)', color: '#34d399' },
  residual: { label: 'Residual', color: '#94a3b8' },
} as const;

type SegId = keyof typeof SEG_META;

interface Segment {
  id: SegId;
  value: number;
}

interface BarGroup {
  ccy: string;
  sources: Segment[];
  /** Total hedge structure (booked + incremental), signed as offset vs exposure. */
  hedge: number;
  hedgeRatio: number;
  delta: number;
  /** Residual after total hedge structure. */
  net: number;
  /** Original stock exposure (local M) — never netted by bookings. */
  stockLocalM: number;
  /** True when remaining net book ≈ 0 — incremental hedge % inactive. */
  hedgeInactive: boolean;
  varBeforeUsdM: number;
  varAfterUsdM: number;
}

interface ConsolidatedLiveLadderProps {
  rows: RowState[];
  risk: CurrencyRiskRow[];
  hedgeRatios?: Record<string, number>;
  onHedgeRatiosChange?: (ratios: Record<string, number>) => void;
  /** Booked Decision-layer trades — shown as hedge structure (not netted into sources). */
  bookedHedges?: HedgeTicket[];
  varSetup?: VarSetup;
  title?: string;
}

function fmtSigned(v: number): string {
  if (Math.abs(v) < 0.005) return '0';
  const sign = v >= 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toFixed(2)}`;
}

function fmtVarK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
}

export function ConsolidatedLiveLadder({
  rows,
  risk,
  hedgeRatios: controlledRatios,
  onHedgeRatiosChange,
  bookedHedges = [],
  varSetup = DEFAULT_VAR_SETUP,
  title = 'Consolidated Live Ladder',
}: ConsolidatedLiveLadderProps) {
  const [localRatios, setLocalRatios] = useState<Record<string, number>>({});
  const [perspective, setPerspective] = useState<LadderPerspective>('fxRisk');
  const [unit, setUnit] = useState<'local' | 'usd'>('local');

  const ratios = controlledRatios ?? localRatios;
  const setRatios = (next: Record<string, number>) => {
    if (onHedgeRatiosChange) onHedgeRatiosChange(next);
    else setLocalRatios(next);
  };

  /** Decision-layer residual VaR (booked netted for incremental %). */
  const hedgeSummary = useMemo(
    () => buildHedgeVarSummary(risk, ratios, varSetup, bookedHedges),
    [risk, ratios, varSetup, bookedHedges],
  );

  /** Unhedged originals — VaR @ Δ=1 and source baseline for the ladder. */
  const unhedgedSummary = useMemo(
    () => buildHedgeVarSummary(risk, {}, varSetup, []),
    [risk, varSetup],
  );

  const hedgeByCcy = useMemo(() => {
    const map = new Map<string, HedgeVarRow>();
    for (const r of hedgeSummary.rows) map.set(r.ccy, r);
    return map;
  }, [hedgeSummary]);

  const unhedgedByCcy = useMemo(() => {
    const map = new Map<string, HedgeVarRow>();
    for (const r of unhedgedSummary.rows) map.set(r.ccy, r);
    return map;
  }, [unhedgedSummary]);

  const bars = useMemo((): BarGroup[] => {
    return rows
      .filter(r => r.ccy !== 'USD')
      .map(r => {
        const hv = hedgeByCcy.get(r.ccy);
        const open = unhedgedByCcy.get(r.ccy);
        const ratio = ratios[r.ccy] ?? 0;

        // Original FX legs — never scaled by bookings.
        const cashFx = r.spot;
        const nca = r.nonCashAsset ?? 0;
        const liability = r.nonCash;
        const debt = r.ir_liab_notional;
        const invest = r.ir_invest_notional ?? 0;
        const originalFx = cashFx + nca + liability;

        // Analytics-basis original + total hedge structure (booked + incremental).
        const rawLocal = open?.exposureLocalM ?? originalFx;
        const bookedAmt = bookedNotionalLocalM(bookedHedges, r.ccy);
        const netBook = rawLocal - bookedAmt;
        const incremental = netBook * ratio;
        const totalHedge = bookedAmt + incremental;
        const hedgeSigned = -totalHedge;
        const hedgeInactive = Math.abs(netBook) < 1e-9;
        // Cover ratio vs original (for Δ / chart balance), not incremental-only.
        const coverRatio =
          Math.abs(rawLocal) < 1e-12
            ? 0
            : Math.min(1, Math.abs(totalHedge) / Math.abs(rawLocal));

        const toUnit = (v: number) => (unit === 'usd' ? fcyToUsdM(v, r.ccy) : v);

        let sources: Segment[] = [];
        let hedge = 0;
        let net = 0;

        if (perspective === 'fxRisk') {
          const fx: Segment[] = [
            { id: 'cashFx', value: toUnit(cashFx) },
            { id: 'nca', value: toUnit(nca) },
            { id: 'liability', value: toUnit(liability) },
          ];
          sources = fx.filter(s => Math.abs(s.value) > 1e-9);
          hedge = toUnit(hedgeSigned);
          // Visual residual of drawn columns (stock sources + hedge structure).
          net = toUnit(originalFx + hedgeSigned);
        } else if (perspective === 'cashCarry') {
          const m = r.r_FCY / 100 / 12;
          const carry: Segment[] = [
            { id: 'cashFx', value: toUnit(cashFx * m) },
            { id: 'nca', value: toUnit(nca * m) },
            { id: 'liability', value: toUnit(liability * m) },
            { id: 'debt', value: toUnit((-Math.abs(debt) || 0) * m) },
            { id: 'invest', value: toUnit(invest * m) },
          ];
          sources = carry.filter(s => Math.abs(s.value) > 1e-12);
          hedge = toUnit(hedgeSigned * m);
          net = sources.reduce((s, seg) => s + seg.value, 0) + hedge;
        } else if (perspective === 'dv01') {
          const dur = r.ir_net_dur > 0 ? r.ir_net_dur : 1;
          const debtDv = -(Math.abs(debt) || 0) * dur * 0.0001;
          const investDv = invest * dur * 0.0001;
          const dv: Segment[] = [
            { id: 'dv01Debt', value: toUnit(debtDv) },
            { id: 'dv01Invest', value: toUnit(investDv) },
          ];
          sources = dv.filter(s => Math.abs(s.value) > 1e-14);
          hedge = toUnit(-(debtDv + investDv) * coverRatio);
          net = sources.reduce((s, seg) => s + seg.value, 0) + hedge;
        } else {
          const gk: Segment[] = [{ id: 'greeksSpot', value: toUnit(originalFx) }];
          sources = gk.filter(s => Math.abs(s.value) > 1e-9);
          hedge = toUnit(hedgeSigned * 0.5);
          net = sources.reduce((s, seg) => s + seg.value, 0) + hedge;
        }

        return {
          ccy: r.ccy,
          sources,
          hedge,
          // Slider stays on incremental % of remaining net book (Decision sync).
          hedgeRatio: hedgeInactive ? 0 : ratio,
          delta: 1 - coverRatio,
          net,
          stockLocalM: originalFx,
          hedgeInactive,
          varBeforeUsdM: open?.varBeforeUsdM ?? 0,
          varAfterUsdM: hv?.varAfterUsdM ?? open?.varBeforeUsdM ?? 0,
        };
      })
      .sort((a, b) => {
        const ai = hedgeSummary.rows.findIndex(r => r.ccy === a.ccy);
        const bi = hedgeSummary.rows.findIndex(r => r.ccy === b.ccy);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1;
        if (bi >= 0) return 1;
        return a.ccy.localeCompare(b.ccy);
      });
  }, [
    rows,
    ratios,
    perspective,
    unit,
    hedgeByCcy,
    unhedgedByCcy,
    hedgeSummary.rows,
    bookedHedges,
  ]);

  const persMeta = PERSPECTIVES.find(p => p.id === perspective)!;
  const inactive = !persMeta.active;

  const legendIds = useMemo(() => {
    const ids = new Set<SegId>();
    for (const b of bars) {
      for (const s of b.sources) ids.add(s.id);
      if (Math.abs(b.hedge) > 1e-9) ids.add('hedge');
    }
    return Array.from(ids);
  }, [bars]);

  const varBeforeUsdM = unhedgedSummary.totalVarBeforeUsdM;
  const varAfterUsdM = hedgeSummary.totalVarAfterUsdM;
  const varReductionUsdM = varBeforeUsdM - varAfterUsdM;
  const reductionPct = varBeforeUsdM > 1e-12 ? (varReductionUsdM / varBeforeUsdM) * 100 : 0;
  const totalHedgeAddLocalM = bars.reduce((s, b) => s + Math.abs(b.hedge), 0);

  return (
    <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Wired to Hedging Decision
            {bookedHedges.length > 0
              ? ` · ${bookedHedges.length} booked (shown as hedge structure)`
              : ''}{' '}
            · VaR {varSetup.confidencePct}% · {varSetup.horizon} · {varSetup.exposureBasis}
          </p>
        </div>
        <div className="flex rounded-md border border-slate-700 p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setUnit('local')}
            className={`rounded px-2 py-1 ${unit === 'local' ? 'bg-slate-700 text-white' : 'text-slate-400'}`}
          >
            Local M
          </button>
          <button
            type="button"
            onClick={() => setUnit('usd')}
            className={`rounded px-2 py-1 ${unit === 'usd' ? 'bg-slate-700 text-white' : 'text-slate-400'}`}
          >
            $USD M
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {PERSPECTIVES.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPerspective(p.id)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              perspective === p.id
                ? 'border-blue-500 bg-blue-500/15 text-blue-100'
                : 'border-slate-700 text-slate-400 hover:border-slate-500'
            } ${!p.active ? 'opacity-70' : ''}`}
          >
            {p.label}
            {!p.active && (
              <span className="ml-1 text-[9px] uppercase text-slate-600">soon</span>
            )}
          </button>
        ))}
      </div>

      <p className="text-[11px] text-slate-500">
        {persMeta.description}
        {inactive ? ' Values are illustrative until the metric is activated on the risk profile.' : ''}
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="VaR @ Δ = 1"
          value={fmtVarK(varBeforeUsdM)}
          hint={`Original unhedged · ${varSetup.confidencePct}% · ${varSetup.horizon}`}
        />
        <Stat
          label="VaR after hedge"
          value={fmtVarK(varAfterUsdM)}
          hint="After booked + hedge %"
          accent
        />
        <Stat
          label="VaR reduction"
          value={fmtVarK(varReductionUsdM)}
          hint={`${reductionPct.toFixed(0)}% cut`}
        />
        <Stat
          label="Hedge structure"
          value={fmtSigned(totalHedgeAddLocalM)}
          hint="Σ |booked + incremental| local M"
        />
      </div>

      <div className="flex flex-wrap gap-3 text-[10px] text-slate-400">
        {legendIds.map(id => (
          <span key={id} className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: SEG_META[id].color }}
            />
            {SEG_META[id].label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-slate-500">
          <span className="h-px w-3 border-t border-dashed border-slate-300" />
          residual / VaR after
        </span>
      </div>

      {bars.length === 0 ? (
        <p className="py-8 text-center text-xs text-slate-500">No FCY rows to ladder.</p>
      ) : (
        <VerticalStackedChart
          bars={bars}
          yLabel={`${persMeta.yLabel}${unit === 'usd' ? ' · USD' : ' · local'}`}
          showVarAfter={perspective === 'fxRisk'}
        />
      )}

      {perspective === 'fxRisk' && bars.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th className="px-3 py-2 font-medium">CCY</th>
                <th className="px-3 py-2 font-medium">Original stock</th>
                <th className="px-3 py-2 font-medium">Hedge</th>
                <th className="px-3 py-2 font-medium">Add %</th>
                <th className="px-3 py-2 font-medium">Δ</th>
                <th className="px-3 py-2 font-medium">Residual</th>
                <th className="px-3 py-2 font-medium">VaR @ Δ1</th>
                <th className="px-3 py-2 font-medium">VaR after</th>
              </tr>
            </thead>
            <tbody>
              {bars.map(b => (
                <tr key={b.ccy} className="border-b border-slate-800/80 hover:bg-slate-800/40">
                  <td className="px-3 py-2 font-semibold">{b.ccy}</td>
                  <td className="px-3 py-2 font-mono text-slate-300">
                    {fmtSigned(b.stockLocalM)}M
                  </td>
                  <td className="px-3 py-2 font-mono text-emerald-300">
                    {fmtSigned(b.hedge)}M
                  </td>
                  <td className="px-3 py-2">
                    <label
                      className={`flex items-center gap-2${
                        b.hedgeInactive ? ' grayscale' : ''
                      }`}
                    >
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={Math.round(b.hedgeRatio * 100)}
                        disabled={b.hedgeInactive}
                        onChange={e => {
                          const pct = Number(e.target.value) / 100;
                          setRatios({ ...ratios, [b.ccy]: pct });
                        }}
                        className="w-24 accent-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                        title={
                          b.hedgeInactive
                            ? 'Fully covered by booked hedges — cancel a trade or switch Analytics basis'
                            : 'Incremental hedge % on remaining net book'
                        }
                      />
                      <span
                        className={`w-10 tabular-nums ${
                          b.hedgeInactive ? 'text-slate-500' : 'text-emerald-300'
                        }`}
                      >
                        {Math.round(b.hedgeRatio * 100)}%
                      </span>
                    </label>
                  </td>
                  <td className="px-3 py-2 font-mono text-amber-300">{b.delta.toFixed(2)}</td>
                  <td className="px-3 py-2 font-mono text-slate-400">{fmtSigned(b.net)}</td>
                  <td className="px-3 py-2 font-mono">{fmtVarK(b.varBeforeUsdM)}</td>
                  <td className="px-3 py-2 font-mono font-semibold text-emerald-300">
                    {fmtVarK(b.varAfterUsdM)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-slate-500">
        Left column keeps original exposure sources. Right column shows the hedge structure from
        Hedging Decision (booked trades + incremental %). Residual / VaR after update when you book
        or cancel hedges.
      </p>
    </div>
  );
}

/** Vertical stacked column chart: currencies on X, exposure on Y. */
function VerticalStackedChart({
  bars,
  yLabel,
  showVarAfter,
}: {
  bars: BarGroup[];
  yLabel: string;
  showVarAfter: boolean;
}) {
  const W = 720;
  const H = showVarAfter ? 340 : 320;
  const pad = { top: 28, right: 16, bottom: showVarAfter ? 56 : 48, left: 52 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const maxPos = niceMax(
    Math.max(
      0.1,
      ...bars.map(b => {
        const srcPos = b.sources.filter(s => s.value > 0).reduce((a, s) => a + s.value, 0);
        const hedgePos = b.hedge > 0 ? b.hedge : 0;
        return Math.max(srcPos, hedgePos, b.net > 0 ? b.net : 0);
      }),
    ),
  );
  const maxNeg = niceMax(
    Math.max(
      0.1,
      ...bars.map(b => {
        const srcNeg = b.sources.filter(s => s.value < 0).reduce((a, s) => a + Math.abs(s.value), 0);
        const hedgeNeg = b.hedge < 0 ? Math.abs(b.hedge) : 0;
        return Math.max(srcNeg, hedgeNeg, b.net < 0 ? Math.abs(b.net) : 0);
      }),
    ),
  );

  const yMax = maxPos;
  const yMin = -maxNeg;
  const yRange = yMax - yMin || 1;

  const yScale = (v: number) => pad.top + ((yMax - v) / yRange) * innerH;
  const zeroY = yScale(0);

  const n = bars.length;
  const slot = innerW / Math.max(n, 1);
  const groupW = Math.min(72, slot * 0.78);
  const colGap = 3;
  const colW = (groupW - colGap) / 2;

  const ticks = 4;
  const yTicks: number[] = [];
  for (let i = 0; i <= ticks; i++) {
    yTicks.push(yMin + (yRange * i) / ticks);
  }

  return (
    <div className="w-full overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40 p-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full min-w-[520px]"
        role="img"
        aria-label="Consolidated live ladder — exposure vs hedge with VaR after"
      >
        {yTicks.map(t => {
          const y = yScale(t);
          return (
            <g key={`yt-${t}`}>
              <line
                x1={pad.left}
                x2={pad.left + innerW}
                y1={y}
                y2={y}
                stroke={Math.abs(t) < 1e-9 ? '#64748b' : '#1e293b'}
                strokeWidth={Math.abs(t) < 1e-9 ? 1.25 : 1}
              />
              <text
                x={pad.left - 8}
                y={y + 3}
                textAnchor="end"
                className="fill-slate-500"
                style={{ fontSize: 10, fontFamily: 'ui-monospace, monospace' }}
              >
                {fmtSigned(t)}
              </text>
            </g>
          );
        })}

        <text
          x={14}
          y={pad.top + innerH / 2}
          textAnchor="middle"
          transform={`rotate(-90 14 ${pad.top + innerH / 2})`}
          className="fill-slate-500"
          style={{ fontSize: 10 }}
        >
          {yLabel}
        </text>

        {bars.map((b, i) => {
          const cx = pad.left + slot * i + slot / 2;
          const srcX = cx - groupW / 2;
          const hedgeX = srcX + colW + colGap;

          let posY = zeroY;
          let negY = zeroY;
          const sourceRects: { id: SegId; x: number; y: number; h: number; value: number }[] = [];
          for (const s of b.sources) {
            const h = (Math.abs(s.value) / yRange) * innerH;
            if (s.value >= 0) {
              posY -= h;
              sourceRects.push({ id: s.id, x: srcX, y: posY, h, value: s.value });
            } else {
              sourceRects.push({ id: s.id, x: srcX, y: negY, h, value: s.value });
              negY += h;
            }
          }

          const hedgeH = (Math.abs(b.hedge) / yRange) * innerH;
          const hedgeY = b.hedge >= 0 ? zeroY - hedgeH : zeroY;
          const netY = yScale(b.net);
          const balanced = Math.abs(b.hedge) > 1e-9;

          return (
            <g key={b.ccy}>
              {sourceRects.map(r => (
                <rect
                  key={`${b.ccy}-${r.id}-${r.value}`}
                  x={r.x}
                  y={r.y}
                  width={colW}
                  height={Math.max(r.h, 0)}
                  fill={SEG_META[r.id].color}
                  opacity={0.92}
                >
                  <title>{`${b.ccy} ${SEG_META[r.id].label}: ${fmtSigned(r.value)}M`}</title>
                </rect>
              ))}

              {/* Empty hedge slot outline when unhedged — shows where balance will land */}
              {!balanced && (
                <rect
                  x={hedgeX}
                  y={zeroY - 4}
                  width={colW}
                  height={4}
                  fill="none"
                  stroke="#334155"
                  strokeDasharray="2 2"
                />
              )}

              {Math.abs(b.hedge) > 1e-9 && (
                <rect
                  x={hedgeX}
                  y={hedgeY}
                  width={colW}
                  height={Math.max(hedgeH, 0)}
                  fill={SEG_META.hedge.color}
                  opacity={0.95}
                  stroke="#065f46"
                  strokeWidth={0.5}
                >
                  <title>{`${b.ccy} Hedge (Decision): ${fmtSigned(b.hedge)}M · Δ=${b.delta.toFixed(2)}`}</title>
                </rect>
              )}

              <line
                x1={srcX - 2}
                x2={hedgeX + colW + 2}
                y1={netY}
                y2={netY}
                stroke="#e2e8f0"
                strokeWidth={1.25}
                strokeDasharray="3 2"
              />
              <circle cx={hedgeX + colW + 2} cy={netY} r={2.5} fill="#e2e8f0" />

              <text
                x={cx}
                y={H - (showVarAfter ? 40 : 28)}
                textAnchor="middle"
                className="fill-slate-300"
                style={{ fontSize: 11, fontWeight: 600 }}
              >
                {b.ccy}
              </text>
              <text
                x={cx}
                y={H - (showVarAfter ? 26 : 14)}
                textAnchor="middle"
                className="fill-slate-500"
                style={{ fontSize: 9, fontFamily: 'ui-monospace, monospace' }}
              >
                res {fmtSigned(b.net)}
              </text>
              {showVarAfter && (
                <text
                  x={cx}
                  y={H - 12}
                  textAnchor="middle"
                  className="fill-emerald-400"
                  style={{ fontSize: 9, fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}
                >
                  VaR {fmtVarK(b.varAfterUsdM)}
                </text>
              )}
            </g>
          );
        })}

        <text
          x={pad.left + innerW / 2}
          y={H - 2}
          textAnchor="middle"
          className="fill-slate-500"
          style={{ fontSize: 10 }}
        >
          Currency
        </text>
      </svg>
      <div className="mt-1 flex flex-wrap gap-4 px-2 text-[10px] text-slate-500">
        <span>Left = original exposure sources</span>
        <span>Right = booked + proposed hedge structure</span>
        <span>Dashed tick = residual · label = VaR after</span>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        accent
          ? 'border-emerald-600/40 bg-emerald-500/10'
          : 'border-slate-800 bg-slate-950/50'
      }`}
    >
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${accent ? 'text-emerald-300' : ''}`}>
        {value}
      </div>
      <div className="text-[10px] text-slate-600">{hint}</div>
    </div>
  );
}
