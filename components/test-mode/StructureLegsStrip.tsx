'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CURRENCY_PARAMS } from '@/lib/fx-buffer';
import { shortOptionCarryUsdYr } from '@/lib/fx-hedge';
import type { LiquiditySwapLegRow } from '@/lib/test-mode/liquidity-strategies';
import {
  hedgeOverlayNotionalFcyM,
  stripDisplayedSwapFcyM,
  type StandingStripMode,
} from '@/lib/test-mode/liquidity-strip-stage';
import type { AskFillMode } from '@/lib/test-mode/solution-pick';
import {
  OPTION_CUTS,
  OPTION_DIRECTIONS,
  OPTION_PREMIUM_STYLES,
  OPTION_STRIKE_MODES,
  OPTION_STRUCTURES,
  SWAP_LEG_STYLES,
  SWAP_TENOR_KEYS,
  addFwdSwapLeg,
  applySwapStyle,
  applySwapTenorKey,
  defaultOptionDraft,
  patchBookSwapLeg,
  patchBookSwapNotional,
  removeBookSwapLeg,
  scalePricedStripToStanding,
  structureStripBands,
  swapCardSub,
  swapCardTenor,
  swapTenorKey,
  type OptionCut,
  type OptionDirection,
  type OptionPremiumStyle,
  type OptionStrikeMode,
  type OptionStructure,
  type StructureOptionDraft,
  type SwapLegStyle,
} from '@/lib/test-mode/structure-legs-strip';

export type StructureLegsOverlay = {
  fcyM: number;
  usdM: number;
  carryUsdYrM?: number;
};

type Sel =
  | { kind: 'overlay' }
  | { kind: 'swap'; index: number }
  | { kind: 'option'; index: number };

function fmtM(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-12) return '0.00M';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}M`;
}

function fmtUsdK(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 5e-8) return '$0K';
  const k = usdM * 1000;
  if (Math.abs(usdM) >= 1 - 1e-9) {
    return `${usdM >= 0 ? '+' : '−'}$${Math.abs(usdM).toFixed(1)}M`;
  }
  const dec = Math.abs(k) < 10 ? 1 : 0;
  return `${k >= 0 ? '+' : '−'}$${Math.abs(k).toFixed(dec)}K`;
}

function optionPremiumUsdM(
  ccy: string,
  draft: StructureOptionDraft,
  rates: { r_FCY: number; r_USD: number; sigmaDaily: number } | undefined,
): { premium: number; carry: number } {
  const p = CURRENCY_PARAMS[ccy];
  const sigma = rates?.sigmaDaily ?? p?.σ_daily ?? 0;
  const rFcy = rates?.r_FCY ?? p?.carry ?? 0;
  const rUsd = rates?.r_USD ?? 0;
  const signed = draft.direction === 'Buy call'
    ? Math.abs(draft.notional)
    : -Math.abs(draft.notional);
  const priced = shortOptionCarryUsdYr(
    signed,
    Math.max(0.05, Math.min(1, draft.delta / 100)),
    Math.max(1, draft.months) * 30,
    ccy,
    rFcy,
    rUsd,
    sigma,
  );
  const earned = priced.premiumEarnedUsdYr;
  const premium = draft.direction === 'Sell' ? earned : -earned;
  return { premium, carry: priced.deliveryLegCarryUsdYr };
}

function hueFor(kind: 'swap' | 'option' | 'overlay'): string {
  if (kind === 'option') return '#c4b5fd';
  if (kind === 'overlay') return '#7dd3fc';
  return '#6ee7b7';
}

function SegField({
  label,
  hint,
  value,
  options,
  onPick,
  accent = 'violet',
}: {
  label: string;
  hint: string;
  value: string;
  options: readonly string[];
  onPick: (v: string) => void;
  accent?: 'violet' | 'emerald';
}) {
  const on = accent === 'emerald'
    ? 'bg-emerald-500/20 text-emerald-200'
    : 'bg-violet-500/25 text-violet-200';
  return (
    <div className="min-w-0">
      <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.07em] text-slate-400">
        {label}
      </div>
      <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-md border border-slate-700 bg-slate-950/60 p-0.5">
        {options.map(o => (
          <button
            key={o}
            type="button"
            onClick={() => onPick(o)}
            className={`whitespace-nowrap rounded px-2 py-1 font-mono text-[9px] font-semibold ${
              value === o ? on : 'bg-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {o}
          </button>
        ))}
      </div>
      <div className="mt-1 font-mono text-[8px] leading-snug text-slate-500">{hint}</div>
    </div>
  );
}

function NumField({
  label,
  hint,
  value,
  unit,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  unit: string;
  onChange: (n: number) => void;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.07em] text-slate-400">
        {label}
      </div>
      <span className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={e => onChange(Number(e.target.value) || 0)}
          className="min-w-0 w-full rounded-[5px] border border-slate-700 bg-[#0b1220] px-[7px] py-[5px] text-right font-mono text-[11px] font-semibold text-slate-50 outline-none"
        />
        <span className="shrink-0 font-mono text-[9px] text-slate-500">{unit}</span>
      </span>
      <div className="mt-1 font-mono text-[8px] leading-snug text-slate-500">{hint}</div>
    </div>
  );
}

function RangeField({
  label,
  hint,
  value,
  min,
  max,
  step,
  display,
  accent,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  accent: string;
  onChange: (n: number) => void;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.07em] text-slate-400">
        {label}
      </div>
      <span className="flex items-center gap-1.5">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="min-w-0 flex-1"
          style={{ accentColor: accent }}
        />
        <span
          className="min-w-[40px] shrink-0 text-right font-mono text-[11px] font-semibold"
          style={{ color: accent }}
        >
          {display}
        </span>
      </span>
      <div className="mt-1 font-mono text-[8px] leading-snug text-slate-500">{hint}</div>
    </div>
  );
}

function ReadField({
  label,
  hint,
  display,
  fg,
}: {
  label: string;
  hint: string;
  display: string;
  fg: string;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.07em] text-slate-400">
        {label}
      </div>
      <span className={`block font-mono text-[12px] font-semibold leading-tight ${fg}`}>
        {display}
      </span>
      <div className="mt-1 font-mono text-[8px] leading-snug text-slate-500">{hint}</div>
    </div>
  );
}

export function StructureLegsStrip({
  ccy,
  schedule,
  bookingMode,
  fillMode,
  overlay = null,
  selectedStanding,
  bookStanding,
  isOrigin,
  unfunded,
  onScheduleChange,
  onScheduleReset,
  rates,
}: {
  ccy: string;
  schedule: readonly LiquiditySwapLegRow[];
  bookingMode?: StandingStripMode;
  /** Selected structure: overlay Mix, funding SWAP, or both. */
  fillMode?: AskFillMode;
  overlay?: StructureLegsOverlay | null;
  selectedStanding: number;
  bookStanding: number;
  isOrigin: boolean;
  unfunded: boolean;
  onScheduleChange?: (next: LiquiditySwapLegRow[]) => void;
  onScheduleReset?: () => void;
  rates?: { r_FCY: number; r_USD: number; sigmaDaily: number };
}) {
  const [localSchedule, setLocalSchedule] = useState<LiquiditySwapLegRow[]>(
    () => [...schedule],
  );
  const [options, setOptions] = useState<StructureOptionDraft[]>([]);
  const [sel, setSel] = useState<Sel | null>(null);
  const controlled = onScheduleChange != null;

  useEffect(() => {
    if (!controlled) setLocalSchedule([...schedule]);
  }, [schedule, controlled]);

  useEffect(() => {
    setOptions([]);
    setSel(null);
  }, [ccy]);

  const bands = structureStripBands(fillMode);

  useEffect(() => {
    const next = structureStripBands(fillMode);
    setSel(cur => {
      if (!cur) return cur;
      if (cur.kind === 'swap' && !next.swap) return null;
      if (cur.kind === 'overlay' && !next.overlay) return null;
      return cur;
    });
  }, [fillMode]);

  const book = controlled ? schedule : localSchedule;
  const writeBook = (next: LiquiditySwapLegRow[]) => {
    if (onScheduleChange) onScheduleChange(next);
    else setLocalSchedule(next);
  };

  const displaySwaps = useMemo(() => {
    if (!bands.swap || book.length === 0) return [];
    // Origin has no standing to scale to — show the live Book-nest strip.
    if (isOrigin || Math.abs(selectedStanding) < 0.01) return [...book];
    return scalePricedStripToStanding(book, selectedStanding);
  }, [bands.swap, book, isOrigin, selectedStanding]);

  const overlayFcy = overlay ? hedgeOverlayNotionalFcyM(overlay.fcyM) : 0;
  const hasOverlay = bands.overlay && overlay != null && Math.abs(overlayFcy) > 0.001;

  const swapAbs = displaySwaps.reduce(
    (s, l) => s + Math.abs(stripDisplayedSwapFcyM(l, bookingMode)),
    0,
  );
  const optAbs = options.reduce((s, l) => s + Math.abs(l.notional), 0);
  const premTot = options.reduce((s, l) => s + optionPremiumUsdM(ccy, l, rates).premium, 0);
  const coverS = Math.abs(selectedStanding) > 0.01
    ? Math.abs(selectedStanding)
    : Math.abs(bookStanding);
  const covered = coverS > 0.01
    ? (swapAbs + optAbs + (hasOverlay ? Math.abs(overlayFcy) : 0)) / coverS * 100
    : 0;

  const empty = displaySwaps.length === 0 && !hasOverlay && options.length === 0;
  const nLegs = displaySwaps.length + (hasOverlay ? 1 : 0) + options.length;
  const note = empty
    ? (unfunded
      ? 'no legs — overdraft regime books nothing'
      : !bands.swap
        ? 'no legs — overlay mix is flat'
        : 'no legs — click + Swap or + Option')
    : `${nLegs} leg${nLegs === 1 ? '' : 's'} · click a leg to configure`;

  const tenorOptions = (current: string): string[] => {
    const keys = [...SWAP_TENOR_KEYS] as string[];
    if (current && !keys.includes(current)) keys.push(current);
    return keys;
  };

  const reset = () => {
    setOptions([]);
    setSel(null);
    if (onScheduleReset) onScheduleReset();
    else if (!controlled) setLocalSchedule([...schedule]);
  };

  const addSwap = () => {
    if (!bands.swap) return;
    const next = addFwdSwapLeg(book, bookStanding || selectedStanding);
    writeBook(next);
    setSel({ kind: 'swap', index: next.length - 1 });
  };

  const addOption = () => {
    const draft = defaultOptionDraft(
      bookStanding || selectedStanding,
      Math.max(displaySwaps.length, 1),
      options.length,
    );
    setOptions(prev => [...prev, draft]);
    setSel({ kind: 'option', index: options.length });
  };

  const patchOption = (index: number, patch: Partial<StructureOptionDraft>) => {
    setOptions(prev => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const toggle = (next: Sel) => {
    setSel(cur => (
      cur && cur.kind === next.kind
        && ('index' in cur ? cur.index : -1) === ('index' in next ? next.index : -1)
        ? null
        : next
    ));
  };

  let cfgTitle = '';
  let cfgLine = '';
  let cfgOption = false;
  let removable = false;
  let fields: ReactNode = null;
  let readouts: { label: string; value: string; fg: string }[] = [];

  if (sel?.kind === 'overlay' && overlay) {
    cfgTitle = `${ccy} overlay mix`;
    cfgLine = 'Σ⁻¹μ overlay — Mix FCY, not a funding-swap leg.';
    cfgOption = false;
    removable = false;
    fields = (
      <>
        <ReadField
          label="Kind"
          display="overlay mix"
          fg="text-sky-300"
          hint="booked as one bullet spot on the parent nest"
        />
        <ReadField
          label="Notional"
          display={`${fmtM(overlayFcy)} FCY`}
          fg="text-sky-200"
          hint="same Mix FCY as the Book nest overlay row"
        />
        <ReadField
          label="USD"
          display={fmtM(overlay.usdM).replace('M', '') + 'M USD'}
          fg="text-sky-200"
          hint="Mix $ — not Overlay $ + Book $"
        />
      </>
    );
    readouts = [
      {
        label: 'Overlay carry',
        value: overlay.carryUsdYrM != null ? fmtUsdK(overlay.carryUsdYrM) : '—',
        fg: (overlay.carryUsdYrM ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300',
      },
      { label: 'Optionality', value: 'none', fg: 'text-slate-400' },
    ];
  } else if (sel?.kind === 'swap' && displaySwaps[sel.index] && book[sel.index]) {
    const shown = displaySwaps[sel.index]!;
    const style = swapCardSub(shown, bookingMode);
    const tenor = swapTenorKey(shown);
    const notional = stripDisplayedSwapFcyM(shown, bookingMode);
    cfgTitle = `${ccy} ${swapCardTenor(shown)} swap leg`;
    cfgLine = 'Funding leg — points priced off CIP, no optionality.';
    removable = true;
    fields = (
      <>
        <SegField
          label="Leg style"
          hint="spot-start prices today"
          value={style}
          options={SWAP_LEG_STYLES}
          accent="emerald"
          onPick={v => writeBook(patchBookSwapLeg(
            book, sel.index, l => applySwapStyle(l, v as SwapLegStyle),
          ))}
        />
        <NumField
          label="Notional"
          hint="near leg book-now"
          value={notional.toFixed(2)}
          unit="M FCY"
          onChange={n => writeBook(patchBookSwapNotional(
            book, sel.index, n, selectedStanding, bookingMode,
          ))}
        />
        <SegField
          label="Tenor"
          hint="value date bucket"
          value={tenor}
          options={tenorOptions(tenor)}
          accent="emerald"
          onPick={v => writeBook(patchBookSwapLeg(
            book, sel.index, l => applySwapTenorKey(l, v),
          ))}
        />
      </>
    );
    readouts = [
      {
        label: 'Points',
        value: fmtUsdK(shown.pointsUsdYr),
        fg: shown.pointsUsdYr >= 0 ? 'text-emerald-300' : 'text-rose-300',
      },
      {
        label: 'Leg carry',
        value: fmtUsdK(shown.netUsdYr),
        fg: shown.netUsdYr >= 0 ? 'text-emerald-300' : 'text-rose-300',
      },
      { label: 'Optionality', value: 'none', fg: 'text-slate-400' },
    ];
  } else if (sel?.kind === 'option' && options[sel.index]) {
    const cur = options[sel.index]!;
    const { premium, carry } = optionPremiumUsdM(ccy, cur, rates);
    cfgTitle = `${ccy} ${cur.tenor} option leg`;
    cfgLine = `${cur.direction} ${cur.structure} · ${
      cur.strikeMode === 'Delta' ? `${cur.delta}Δ` : cur.strikeMode
    } · ${cur.months}m`;
    cfgOption = true;
    removable = true;
    const deltaHedge = cur.notional * cur.delta / 100;
    fields = (
      <>
        <SegField
          label="Structure"
          hint="collar funds the premium"
          value={cur.structure}
          options={OPTION_STRUCTURES}
          onPick={v => patchOption(sel.index, { structure: v as OptionStructure })}
        />
        <SegField
          label="Direction"
          hint="protection vs premium income"
          value={cur.direction}
          options={OPTION_DIRECTIONS}
          onPick={v => patchOption(sel.index, { direction: v as OptionDirection })}
        />
        <SegField
          label="Strike"
          hint="how the strike is set"
          value={cur.strikeMode}
          options={OPTION_STRIKE_MODES}
          onPick={v => patchOption(sel.index, { strikeMode: v as OptionStrikeMode })}
        />
        <RangeField
          label="Delta"
          hint="moneyness of the strike"
          value={cur.delta}
          min={5}
          max={50}
          step={5}
          display={`${cur.delta}Δ`}
          accent="#c4b5fd"
          onChange={n => patchOption(sel.index, { delta: n })}
        />
        <NumField
          label="Notional"
          hint="per-leg face"
          value={cur.notional.toFixed(2)}
          unit="M FCY"
          onChange={n => patchOption(sel.index, { notional: n })}
        />
        <RangeField
          label="Expiry"
          hint="option tenor"
          value={cur.months}
          min={1}
          max={12}
          step={1}
          display={`${cur.months}m`}
          accent="#7dd3fc"
          onChange={n => patchOption(sel.index, { months: n, tenor: `M${n}` })}
        />
        <SegField
          label="Premium"
          hint="settlement of the premium"
          value={cur.premiumStyle}
          options={OPTION_PREMIUM_STYLES}
          onPick={v => patchOption(sel.index, { premiumStyle: v as OptionPremiumStyle })}
        />
        {cur.structure === 'KO' ? (
          <RangeField
            label="Barrier"
            hint="% of strike · knock-out"
            value={cur.barrier}
            min={101}
            max={130}
            step={1}
            display={`${cur.barrier}%`}
            accent="#fbbf24"
            onChange={n => patchOption(sel.index, { barrier: n })}
          />
        ) : (
          <ReadField
            label="Barrier"
            display="n/a"
            fg="text-slate-500"
            hint="only for KO structures"
          />
        )}
        <SegField
          label="Cut"
          hint="expiry fixing cut"
          value={cur.cut}
          options={OPTION_CUTS}
          onPick={v => patchOption(sel.index, { cut: v as OptionCut })}
        />
      </>
    );
    readouts = [
      {
        label: 'Premium',
        value: fmtUsdK(premium),
        fg: premium >= 0 ? 'text-emerald-300' : 'text-rose-300',
      },
      { label: 'Vega', value: '—', fg: 'text-violet-300' },
      {
        label: 'Δ hedge',
        value: `${cur.direction === 'Buy call' ? '+' : '−'}${Math.abs(deltaHedge).toFixed(2)}M`,
        fg: 'text-sky-300',
      },
      {
        label: 'Protected',
        value: `${cur.notional.toFixed(2)}M at ${
          cur.strikeMode === 'ATMF' ? 'ATMF' : `${cur.delta}Δ`
        }`,
        fg: 'text-slate-200',
      },
      {
        label: 'Carry impact',
        value: fmtUsdK(carry),
        fg: carry >= 0 ? 'text-emerald-300' : 'text-rose-300',
      },
    ];
  }

  const cfgOpen = sel != null && fields != null;

  const cardBtn = (
    id: string,
    on: boolean,
    kind: 'swap' | 'option' | 'overlay',
    tenor: string,
    kindLabel: string,
    notional: string,
    sub: string,
    onClick: () => void,
  ) => {
    const h = hueFor(kind);
    return (
      <button
        key={id}
        type="button"
        onClick={onClick}
        className="min-w-[104px] shrink-0 rounded-[7px] border py-2 pl-[9px] pr-[9px] text-left"
        style={{
          borderTopColor: on ? `${h}99` : '#334155',
          borderRightColor: on ? `${h}99` : '#334155',
          borderBottomColor: on ? `${h}99` : '#334155',
          borderLeftWidth: 3,
          borderLeftColor: h,
          background: on ? `${h}1f` : 'rgba(2,6,23,.6)',
        }}
      >
        <span className="mb-1 flex items-center gap-1.5">
          <span className={`font-mono text-[10px] font-semibold ${on ? 'text-slate-50' : 'text-slate-300'}`}>
            {tenor}
          </span>
          <span
            className="rounded-[3px] border px-[5px] py-px font-mono text-[8px] font-semibold leading-[1.5]"
            style={{
              color: h,
              borderColor: `${h}73`,
              background: `${h}24`,
            }}
          >
            {kindLabel}
          </span>
        </span>
        <span
          className="block font-mono text-[11px] font-semibold leading-tight"
          style={{ color: on ? h : '#e2e8f0' }}
        >
          {notional}
        </span>
        <span className="mt-[3px] block font-mono text-[8px] leading-snug text-slate-500">
          {sub}
        </span>
      </button>
    );
  };

  return (
    <div className="mb-3 rounded-[10px] border border-slate-700 bg-slate-950/50 p-3">
      <div className="mb-[9px] flex flex-wrap items-baseline gap-3">
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-400">
          Structure · legs
        </span>
        <span className="font-mono text-[9px] text-slate-500">{note}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {bands.swap && (
            <button
              type="button"
              onClick={addSwap}
              className="rounded-[5px] border border-emerald-400/45 bg-emerald-500/15 px-[9px] py-1 font-mono text-[9px] font-semibold text-emerald-300"
            >
              + Swap leg
            </button>
          )}
          <button
            type="button"
            onClick={addOption}
            className="rounded-[5px] border border-violet-400/45 bg-violet-500/15 px-[9px] py-1 font-mono text-[9px] font-semibold text-violet-300"
          >
            + Option leg
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded-[5px] border border-slate-600 bg-transparent px-[9px] py-1 font-mono text-[9px] font-semibold text-slate-300"
          >
            Reset
          </button>
        </span>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {hasOverlay && overlay && cardBtn(
          'overlay',
          sel?.kind === 'overlay',
          'overlay',
          'spot',
          'OVLY',
          fmtM(overlayFcy),
          'overlay mix',
          () => toggle({ kind: 'overlay' }),
        )}
        {displaySwaps.map((l, i) => cardBtn(
          `sw-${l.cycleIndex}-${i}`,
          sel?.kind === 'swap' && sel.index === i,
          'swap',
          swapCardTenor(l),
          'SWAP',
          fmtM(stripDisplayedSwapFcyM(l, bookingMode)),
          swapCardSub(l, bookingMode),
          () => toggle({ kind: 'swap', index: i }),
        ))}
        {options.map((l, i) => cardBtn(
          l.id,
          sel?.kind === 'option' && sel.index === i,
          'option',
          l.tenor,
          'OPT',
          fmtM(l.notional),
          `${l.direction} ${l.structure} · ${
            l.strikeMode === 'Delta' ? `${l.delta}Δ` : l.strikeMode
          }`,
          () => toggle({ kind: 'option', index: i }),
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-3.5 border-t border-slate-800 pt-2">
        {(
          [
            { label: 'Σ swap', value: `${swapAbs.toFixed(2)}M`, fg: 'text-emerald-300' },
            { label: 'Σ overlay', value: hasOverlay ? fmtM(overlayFcy) : '0.00M', fg: 'text-sky-300' },
            { label: 'Σ option', value: `${optAbs.toFixed(2)}M`, fg: 'text-violet-300' },
            {
              label: 'Σ premium',
              value: fmtUsdK(premTot),
              fg: premTot >= 0 ? 'text-emerald-300' : 'text-rose-300',
            },
            {
              label: 'Covered',
              value: `${covered.toFixed(0)}% of book S`,
              fg: covered > 105 ? 'text-amber-300' : 'text-slate-200',
            },
          ] as const
        ).map(t => (
          <span
            key={t.label}
            className="inline-flex items-baseline gap-1.5 font-mono text-[9px] leading-snug text-slate-500"
          >
            {t.label}
            <span className={`font-semibold ${t.fg}`}>{t.value}</span>
          </span>
        ))}
      </div>

      {cfgOpen && (
        <div
          className="mt-2.5 rounded-lg border px-3 py-[11px]"
          style={{
            borderColor: cfgOption ? 'rgba(167,139,250,.35)' : 'rgba(52,211,153,.3)',
            background: cfgOption ? 'rgba(167,139,250,.07)' : 'rgba(52,211,153,.06)',
          }}
        >
          <div className="mb-[9px] flex flex-wrap items-baseline gap-[9px]">
            <span className="text-[10px] font-semibold text-slate-50">{cfgTitle}</span>
            <span className="font-mono text-[9px] leading-snug text-slate-400">{cfgLine}</span>
            <span className="ml-auto flex gap-1.5">
              {removable && (
                <button
                  type="button"
                  onClick={() => {
                    if (sel?.kind === 'swap') {
                      writeBook(removeBookSwapLeg(book, sel.index));
                    } else if (sel?.kind === 'option') {
                      setOptions(prev => prev.filter((_, i) => i !== sel.index));
                    }
                    setSel(null);
                  }}
                  className="rounded-[5px] border border-slate-600 bg-transparent px-[9px] py-1 font-mono text-[9px] font-semibold text-slate-300"
                >
                  Remove leg
                </button>
              )}
              <button
                type="button"
                onClick={() => setSel(null)}
                className="rounded-[5px] border border-slate-600 bg-transparent px-[9px] py-1 font-mono text-[9px] font-semibold text-slate-300"
              >
                Close
              </button>
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(148px,1fr))] gap-x-3 gap-y-[9px]">
            {fields}
          </div>
          {readouts.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-3.5 border-t border-slate-800 pt-[9px]">
              {readouts.map(r => (
                <span
                  key={r.label}
                  className="inline-flex items-baseline gap-1.5 font-mono text-[9px] leading-snug text-slate-500"
                >
                  {r.label}
                  <span className={`font-semibold ${r.fg}`}>{r.value}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
