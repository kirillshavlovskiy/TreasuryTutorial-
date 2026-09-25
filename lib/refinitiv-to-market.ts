import {
  parseForwardCurvesRequest,
  type ForwardCurveQuote,
  type ForwardCurvesInput,
} from '@/lib/refinitivForwardCurves';
import {
  parseXccyCurvesRequest,
  type XccyCurveDefinition,
  type XccyCurveQuote,
  type XccyCurvesInput,
} from '@/lib/refinitivCrossCurrencyCurves';
import {
  parseXccyDefinitionsRequest,
  pickXccyDefinition,
  type XccyDefinitionQuery,
  type XccyDefinitionsInput,
  type XccyPublishedDefinition,
} from '@/lib/refinitivXccyDefinitions';
import {
  fxVolSurfaceRequest,
  type SurfaceAxis,
  type VolSurfaceMatrix,
} from '@/lib/refinitivVolSurfaces';
import { CURRENCY_PARAMS } from '@/lib/fx-buffer';
import {
  type DepositTenorRow,
  type FxMarketRatesBundle,
  isUsdPerFcyQuoted,
  normalizeMarketRatesBundle,
  usdMarketPair,
} from '@/lib/fx-market-rates';
import { todayIso } from '@/lib/isoDates';

/** Tenors that map onto the FXO term table (SW→1Y). */
export const MARKET_PULL_TENORS = [
  '1W',
  '1M',
  '2M',
  '3M',
  '6M',
  '9M',
  '1Y',
] as const;

/**
 * Desk FX pillars sent as IPA `curveTenors` (SN/SW labels, 12M not 1Y).
 * Matches the EURUSD seed table plus SN.
 */
export const XCCY_CURVE_TENORS = [
  'SN',
  'SW',
  '2W',
  '3W',
  '1M',
  '2M',
  '3M',
  '4M',
  '5M',
  '6M',
  '7M',
  '8M',
  '9M',
  '10M',
  '11M',
  '12M',
  '15M',
  '18M',
  '21M',
  '2Y',
  '30M',
  '3Y',
  '4Y',
  '5Y',
  '6Y',
  '7Y',
  '8Y',
  '9Y',
  '10Y',
] as const;

const OIS_TENORS = ['OIS', 'ON', '1D'] as const;
const IBOR3_TENORS = ['3M', '6M', '1M'] as const;

type SwapZcSpec = {
  indexName: string;
  name: string;
  /** IPA index tenors to try, first is the default request. */
  indexTenors: readonly string[];
};

const INDEX_BY_CCY: Record<string, SwapZcSpec> = {
  EUR: { indexName: 'EURIBOR', name: 'EUR EURIBOR Swap ZC Curve', indexTenors: IBOR3_TENORS },
  USD: { indexName: 'SOFR', name: 'USD SOFR Swap ZC Curve', indexTenors: OIS_TENORS },
  GBP: { indexName: 'SONIA', name: 'GBP SONIA Swap ZC Curve', indexTenors: OIS_TENORS },
  JPY: { indexName: 'TONAR', name: 'JPY TONAR Swap ZC Curve', indexTenors: OIS_TENORS },
  CHF: { indexName: 'SARON', name: 'CHF SARON Swap ZC Curve', indexTenors: OIS_TENORS },
  AUD: { indexName: 'AONIA', name: 'AUD AONIA Swap ZC Curve', indexTenors: OIS_TENORS },
  CAD: { indexName: 'CORRA', name: 'CAD CORRA Swap ZC Curve', indexTenors: OIS_TENORS },
  MXN: { indexName: 'TIIE', name: 'MXN TIIE Swap ZC Curve', indexTenors: ['28D', '1M', 'ON', 'OIS'] },
  PLN: { indexName: 'WIBOR', name: 'PLN WIBOR Swap ZC Curve', indexTenors: IBOR3_TENORS },
  TRY: { indexName: 'TLREF', name: 'TRY TLREF Swap ZC Curve', indexTenors: OIS_TENORS },
};

export function swapZcSpec(ccy: string): SwapZcSpec {
  const key = ccy.toUpperCase();
  return INDEX_BY_CCY[key] ?? {
    indexName: key,
    name: `${key} Swap ZC Curve`,
    indexTenors: OIS_TENORS,
  };
}

export function swapZcCurveRequest(
  ccy: string,
  valuationDate = todayIso(),
  indexTenor?: string,
): ForwardCurvesInput {
  const spec = swapZcSpec(ccy);
  return parseForwardCurvesRequest({
    currency: ccy.toUpperCase(),
    indexName: spec.indexName,
    name: spec.name,
    discountingTenor: 'OIS',
    indexTenor: indexTenor ?? spec.indexTenors[0] ?? 'OIS',
    forwardCurveTag: `${ccy.toUpperCase()}Fwd`,
    forwardStartDate: valuationDate,
    forwardCurveTenors: [...MARKET_PULL_TENORS],
    valuationDate,
  });
}

export function curveQuoteUsable(curve?: ForwardCurveQuote | null): boolean {
  if (!curve || curve.errorMessage.trim()) return false;
  return curve.points.some(
    p => p.ratePercent != null && Number.isFinite(p.ratePercent),
  );
}

export function dualCcyCurveRequest(
  fcy: string,
  valuationDate = todayIso(),
): ForwardCurvesInput {
  const fcyReq = swapZcCurveRequest(fcy, valuationDate);
  const usdReq = swapZcCurveRequest('USD', valuationDate);
  return { universe: [...fcyReq.universe, ...usdReq.universe] };
}

/** IPA accepts at most 5 curve families per POST. */
export const IPA_CURVE_BATCH = 5;

export function bookCurveRequest(
  ccys: readonly string[],
  valuationDate = todayIso(),
): ForwardCurvesInput {
  const slice = [...new Set(ccys.map(c => c.toUpperCase()))].slice(0, IPA_CURVE_BATCH);
  if (slice.length === 0) throw new Error('No curve families to pull');
  return {
    universe: slice.flatMap(c => swapZcCurveRequest(c, valuationDate).universe),
  };
}

export function tenorToMonths(tenor: string): number | null {
  const t = tenor.trim().toUpperCase().replace(/\s+/g, '');
  if (t === 'ON' || t === 'O/N' || t === 'ONIGHT' || t === 'OVERNIGHT') return 1 / 30;
  if (t === 'TN' || t === 'T/N' || t === 'TOMNEXT') return 2 / 30;
  if (t === 'SN' || t === 'S/N' || t === 'SW' || t === 'SPOTWEEK') return 7 / 30;
  const m = t.match(/^(\d+)(D|W|M|Y)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === 'D') return n / 30;
  if (m[2] === 'W') return n / 4;
  if (m[2] === 'M') return n;
  return n * 12;
}

function rateByTenor(
  curve: ForwardCurveQuote | undefined,
  tenor: string,
): number | null {
  if (!curve) return null;
  const hit = curve.points.find(
    p => p.tenor.trim().toUpperCase() === tenor.toUpperCase(),
  );
  return hit?.ratePercent ?? null;
}

function pickCurve(
  curves: readonly ForwardCurveQuote[],
  ccy: string,
): ForwardCurveQuote | undefined {
  const key = ccy.toUpperCase();
  return (
    curves.find(c => c.currency.toUpperCase() === key && !c.errorMessage)
    ?? curves.find(c => c.currency.toUpperCase() === key)
  );
}

export function swapPointsFromCip(args: {
  ccy: string;
  spotMid: number;
  rFcyPct: number;
  rUsdPct: number;
  months: number;
}): { bid: number; ask: number } | undefined {
  const { ccy, spotMid, rFcyPct, rUsdPct, months } = args;
  if (!(spotMid > 0) || !(months > 0)) return undefined;
  const t = months / 12;
  const rf = rFcyPct / 100;
  const ru = rUsdPct / 100;
  const F = isUsdPerFcyQuoted(ccy)
    ? spotMid * (1 + ru * t) / (1 + rf * t)
    : spotMid * (1 + rf * t) / (1 + ru * t);
  if (!(F > 0)) return undefined;
  const scale = ccy.toUpperCase() === 'JPY' ? 100 : 10_000;
  const pts = (F - spotMid) * scale;
  return { bid: pts, ask: pts };
}

function deskSpot(ccy: string, bundle?: FxMarketRatesBundle | null): number {
  const mid = bundle?.spot?.mid;
  if (typeof mid === 'number' && mid > 0) return mid;
  const usdPerFcy = CURRENCY_PARAMS[ccy]?.spot;
  if (!(usdPerFcy > 0)) return 0;
  return isUsdPerFcyQuoted(ccy) ? usdPerFcy : 1 / usdPerFcy;
}

export function depositsFromForwardCurves(
  curves: readonly ForwardCurveQuote[],
  fcy: string,
  existing?: FxMarketRatesBundle | null,
): DepositTenorRow[] {
  const fcyCurve = pickCurve(curves, fcy);
  const usdCurve = pickCurve(curves, 'USD');
  const spot = deskSpot(fcy, existing);
  const rows: DepositTenorRow[] = [];
  for (const tenor of MARKET_PULL_TENORS) {
    const rFcy = rateByTenor(fcyCurve, tenor);
    if (rFcy == null) continue;
    const rUsd = rateByTenor(usdCurve, tenor) ?? rFcy;
    const months = tenorToMonths(tenor);
    const pts = months != null
      ? swapPointsFromCip({
          ccy: fcy,
          spotMid: spot,
          rFcyPct: rFcy,
          rUsdPct: rUsd,
          months,
        })
      : undefined;
    rows.push({
      tenor,
      months,
      eur: { creditPct: rFcy, debitPct: rFcy },
      usd: { creditPct: rUsd, debitPct: rUsd },
      ...(pts ? { swapPoints: pts } : {}),
    });
  }
  return rows;
}

/** RFR index IPA uses on the cross-currency-curves endpoint. */
const XCCY_INDEX: Record<string, string> = {
  EUR: 'ESTR',
  USD: 'SOFR',
  GBP: 'SONIA',
  JPY: 'TONAR',
  CHF: 'SARON',
  AUD: 'AONIA',
  CAD: 'CORRA',
  MXN: 'TIIE',
  PLN: 'WIBOR',
  TRY: 'TLREF',
  NZD: 'NZIONA',
};

/**
 * Published IPA defs that are not USD SOFR / FCY RFR Swap.
 * USDPLN is the FxForward fallback (USD LIBOR / PLN WIBOR).
 */
const XCCY_PAIR_OVERRIDE: Record<
  string,
  {
    baseCurrency: string;
    baseIndexName: string;
    quotedCurrency: string;
    quotedIndexName: string;
    mainConstituentAssetClass?: string;
    name?: string;
    source?: string;
  }
> = {
  PLN: {
    baseCurrency: 'USD',
    baseIndexName: 'LIBOR',
    quotedCurrency: 'PLN',
    quotedIndexName: 'WIBOR',
    mainConstituentAssetClass: 'FxForward',
    name: 'USD PLN FxForward',
    source: 'Refinitiv',
  },
};

/** Extra IPA index names when the primary FX-cross definition is missing. */
const XCCY_INDEX_FALLBACKS: Record<string, string[]> = {
  PLN: ['WIBOR', 'WIRON', 'POLSTR', 'POLONIA'],
};

export function xccyIndexName(ccy: string): string {
  const key = ccy.toUpperCase();
  return XCCY_INDEX[key] ?? key;
}

export function xccyIndexFallbacks(ccy: string): string[] {
  const key = ccy.toUpperCase();
  const primary = xccyIndexName(key);
  const extras = XCCY_INDEX_FALLBACKS[key] ?? [];
  return [primary, ...extras.filter(i => i !== primary)];
}

export function xccyPairDefinition(
  fcy: string,
  indexName?: string,
  curveTenors: readonly string[] | null = XCCY_CURVE_TENORS,
): {
  baseCurrency: string;
  baseIndexName: string;
  quotedCurrency: string;
  quotedIndexName: string;
  curveTenors?: string[];
  mainConstituentAssetClass?: string;
  name?: string;
  source?: string;
} {
  const c = fcy.toUpperCase();
  const tenors = curveTenors ? [...curveTenors] : undefined;
  const override = XCCY_PAIR_OVERRIDE[c];
  if (override) {
    const quoted = indexName ?? override.quotedIndexName;
    return {
      baseCurrency: override.baseCurrency,
      baseIndexName: override.baseIndexName,
      quotedCurrency: override.quotedCurrency,
      quotedIndexName: quoted,
      ...(override.mainConstituentAssetClass
        ? { mainConstituentAssetClass: override.mainConstituentAssetClass }
        : {}),
      ...(quoted === override.quotedIndexName && override.name
        ? { name: override.name }
        : {}),
      ...(override.source ? { source: override.source } : {}),
      ...(tenors ? { curveTenors: tenors } : {}),
    };
  }
  const fcyIndex = indexName ?? xccyIndexName(c);
  if (isUsdPerFcyQuoted(c)) {
    return {
      baseCurrency: c,
      baseIndexName: fcyIndex,
      quotedCurrency: 'USD',
      quotedIndexName: xccyIndexName('USD'),
      ...(tenors ? { curveTenors: tenors } : {}),
    };
  }
  return {
    baseCurrency: 'USD',
    baseIndexName: xccyIndexName('USD'),
    quotedCurrency: c,
    quotedIndexName: fcyIndex,
    ...(tenors ? { curveTenors: tenors } : {}),
  };
}

export const IPA_XCCY_BATCH = 5;

export function xccyDefinitionQuery(fcy: string): XccyDefinitionQuery {
  const c = fcy.toUpperCase();
  if (isUsdPerFcyQuoted(c)) {
    return { baseCurrency: c, quotedCurrency: 'USD' };
  }
  return { baseCurrency: 'USD', quotedCurrency: c };
}

export function xccyDefinitionsRequest(
  ccys: readonly string[],
): XccyDefinitionsInput {
  const fcy = [...new Set(ccys.map(c => c.toUpperCase()).filter(c => c !== 'USD'))]
    .slice(0, IPA_XCCY_BATCH);
  if (fcy.length === 0) throw new Error('No FCY pairs to pull');
  return parseXccyDefinitionsRequest({
    universe: fcy.map(c => xccyDefinitionQuery(c)),
  });
}

export function xccyCurveDefFromPublished(
  def: XccyPublishedDefinition,
  curveTenors: readonly string[] | null = XCCY_CURVE_TENORS,
): XccyCurveDefinition {
  const tenors = curveTenors ? [...curveTenors] : undefined;
  return {
    baseCurrency: def.baseCurrency,
    baseIndexName: def.baseIndexName,
    quotedCurrency: def.quotedCurrency,
    quotedIndexName: def.quotedIndexName,
    ...(tenors ? { curveTenors: tenors } : {}),
  };
}

export function xccyCurvesFromPublished(
  defs: readonly XccyPublishedDefinition[],
  curveTenors: readonly string[] | null = XCCY_CURVE_TENORS,
): XccyCurvesInput {
  if (defs.length === 0) throw new Error('No published IPA definitions');
  if (defs.length > IPA_XCCY_BATCH) {
    throw new Error('universe is limited to 5 cross-currency curves');
  }
  return parseXccyCurvesRequest({
    universe: defs.map(d => ({
      curveDefinition: xccyCurveDefFromPublished(d, curveTenors),
    })),
  });
}

export { pickXccyDefinition };

export function bookCcyOfPublished(
  def: Pick<XccyPublishedDefinition, 'baseCurrency' | 'quotedCurrency'>,
  book: readonly string[],
): string | null {
  const keys = [def.baseCurrency, def.quotedCurrency]
    .map(c => c.toUpperCase())
    .filter(c => c && c !== 'USD');
  return book.find(c => keys.includes(c.toUpperCase())) ?? keys[0] ?? null;
}

export function xccyBookRequestFromDefs(
  ccys: readonly string[],
  defByCcy: ReadonlyMap<string, XccyPublishedDefinition>,
): XccyCurvesInput {
  if (ccys.length === 0) throw new Error('No FCY pairs to pull');
  return parseXccyCurvesRequest({
    universe: ccys.map(c => ({
      curveDefinition: (() => {
        const published = defByCcy.get(c.toUpperCase());
        return published
          ? xccyCurveDefFromPublished(published)
          : xccyPairDefinition(c);
      })(),
    })),
  });
}

export function xccyBookRequest(
  ccys: readonly string[],
  _valuationDate = todayIso(),
): XccyCurvesInput {
  const fcy = [...new Set(ccys.map(c => c.toUpperCase()).filter(c => c !== 'USD'))]
    .slice(0, IPA_XCCY_BATCH);
  if (fcy.length === 0) throw new Error('No FCY pairs to pull');
  return parseXccyCurvesRequest({
    universe: fcy.map(c => ({ curveDefinition: xccyPairDefinition(c) })),
  });
}

/** One-pair retry — optional index / tenor list (`null` omits curveTenors). */
export function xccySingleRequest(
  fcy: string,
  indexName?: string,
  curveTenors?: readonly string[] | null,
): XccyCurvesInput {
  return parseXccyCurvesRequest({
    universe: [{
      curveDefinition: xccyPairDefinition(
        fcy,
        indexName ?? xccyIndexName(fcy),
        curveTenors === undefined ? XCCY_CURVE_TENORS : curveTenors,
      ),
    }],
  });
}

export function bookCcyOfXccy(
  curve: XccyCurveQuote,
  book: readonly string[],
): string | null {
  const keys = [curve.baseCurrency, curve.quotedCurrency]
    .map(c => c.toUpperCase())
    .filter(c => c && c !== 'USD');
  return book.find(c => keys.includes(c.toUpperCase())) ?? keys[0] ?? null;
}

function deskTenor(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (t === '12M') return '1Y';
  if (t === '1W') return 'SW';
  return t;
}

const DESK_TENOR_RANK: Record<string, number> = Object.fromEntries(
  ['ON', 'TN', ...XCCY_CURVE_TENORS].map((t, i) => [t, i]),
);

function tenorRank(tenor: string): number {
  const t = deskTenor(tenor);
  if (t in DESK_TENOR_RANK) return DESK_TENOR_RANK[t]!;
  const months = tenorToMonths(t);
  return months != null ? 100 + months : 1_000;
}

function deskTenorMonths(tenor: string): number | null {
  const t = deskTenor(tenor);
  if (t === 'ON' || t === 'SN') return 1 / 30;
  if (t === 'TN') return 2 / 30;
  if (t === 'SW') return 7 / 30;
  return tenorToMonths(t);
}

export function depositsFromXccyCurve(
  curve: XccyCurveQuote,
  existing?: FxMarketRatesBundle | null,
): DepositTenorRow[] {
  const prev = new Map(
    (existing?.deposits ?? []).map(d => [deskTenor(d.tenor), d]),
  );
  for (const p of curve.points) {
    if (p.tenor.toUpperCase() === 'SPOT') continue;
    const tenor = deskTenor(p.tenor);
    const prior = prev.get(tenor);
    prev.set(tenor, {
      tenor,
      months: deskTenorMonths(tenor) ?? prior?.months ?? null,
      eur: prior?.eur ?? { creditPct: 0, debitPct: 0 },
      usd: prior?.usd ?? { creditPct: 0, debitPct: 0 },
      swapPoints: {
        bid: p.swapPoint.bid,
        ask: p.swapPoint.ask,
      },
      outright: {
        bid: p.outright.bid,
        ask: p.outright.ask,
      },
    });
  }
  return [...prev.values()].sort((a, b) => tenorRank(a.tenor) - tenorRank(b.tenor));
}

export function applyXccyCurveToBundle(
  existing: FxMarketRatesBundle,
  curve: XccyCurveQuote,
  fcy: string,
  asOf: string,
): FxMarketRatesBundle {
  if (curve.errorMessage.trim()) throw new Error(curve.errorMessage);
  const deposits = depositsFromXccyCurve(curve, existing);
  if (deposits.length === 0) {
    throw new Error('IPA cross-currency curve had no swap-point tenors');
  }
  const spotPt = curve.points.find(p => p.tenor.toUpperCase() === 'SPOT');
  const mid = spotPt?.outright.mid;
  const bid = spotPt?.outright.bid;
  const ask = spotPt?.outright.ask;
  const spot =
    mid != null && mid > 0
      ? {
          bid: bid && bid > 0 ? bid : mid,
          ask: ask && ask > 0 ? ask : mid,
          mid,
        }
      : existing.spot;
  const spotDate =
    spotPt?.endDate?.slice(0, 10)
    || spotPt?.startDate?.slice(0, 10)
    || curve.valuationDate.slice(0, 10)
    || asOf;
  return normalizeMarketRatesBundle({
    ...existing,
    baseCcy: fcy,
    pair: usdMarketPair(fcy),
    sourceFile: `IPA ${curve.name || `${usdMarketPair(fcy)} XCCY`} ${asOf}`,
    asOf: { tradeDate: asOf, spotDate },
    ...(spot ? { spot } : {}),
    deposits,
  }, fcy);
}

export function applyForwardCurvesToBundle(
  existing: FxMarketRatesBundle,
  curves: readonly ForwardCurveQuote[],
  fcy: string,
  asOf: string,
): FxMarketRatesBundle {
  const deposits = depositsFromForwardCurves(curves, fcy, existing);
  if (deposits.length === 0) {
    const err = pickCurve(curves, fcy)?.errorMessage
      || pickCurve(curves, 'USD')?.errorMessage
      || 'IPA returned no deposit tenors';
    throw new Error(err);
  }
  return normalizeMarketRatesBundle({
    ...existing,
    baseCcy: fcy,
    pair: usdMarketPair(fcy),
    sourceFile: `IPA ${swapZcSpec(fcy).indexName} ${asOf}`,
    asOf: { tradeDate: asOf, spotDate: asOf },
    deposits,
  }, fcy);
}

function labelMonths(label: string): number | null {
  const raw = label.trim();
  const fromTenor = tenorToMonths(raw);
  if (fromTenor != null) return Math.round(fromTenor);
  const d = Date.parse(raw);
  if (!Number.isFinite(d)) return null;
  const days = (d - Date.now()) / 86_400_000;
  if (days < 10) return 1;
  return Math.max(1, Math.min(12, Math.round(days / 30)));
}

function atmRowIndex(surface: VolSurfaceMatrix): number {
  const i = surface.yLabels.findIndex(y => /atm/i.test(y));
  return i >= 0 ? i : 0;
}

/** ATM strip → implied vol decimal by tenor months 1–12. */
export function impliedVolFromSurface(
  surface: VolSurfaceMatrix,
): Record<string, number> {
  const row = atmRowIndex(surface);
  const out: Record<string, number> = {};
  surface.xLabels.forEach((x, col) => {
    const months = labelMonths(x);
    const raw = surface.values[row]?.[col];
    if (months == null || raw == null || !Number.isFinite(raw) || raw <= 0) return;
    const dec = raw > 1.5 ? raw / 100 : raw;
    out[String(Math.max(1, Math.min(12, months)))] = dec;
  });
  return out;
}

export function fxVolPullRequest(
  ccy: string,
  calculationDate = todayIso(),
  axes?: { xAxis?: SurfaceAxis; yAxis?: SurfaceAxis },
) {
  return fxVolSurfaceRequest(usdMarketPair(ccy), calculationDate, axes);
}

/** IPA accepts at most 5 surfaces per POST. */
export const IPA_SURFACE_BATCH = 5;

export function fxVolPullBookRequest(
  ccys: readonly string[],
  calculationDate = todayIso(),
  axes?: { xAxis?: SurfaceAxis; yAxis?: SurfaceAxis },
) {
  const fcy = ccys.filter(c => c !== 'USD').slice(0, IPA_SURFACE_BATCH);
  if (fcy.length === 0) throw new Error('No FCY pairs to pull');
  return {
    universe: fcy.map(
      c => fxVolSurfaceRequest(usdMarketPair(c), calculationDate, axes).universe[0]!,
    ),
  };
}

export function bookCcyOfSurface(
  surface: VolSurfaceMatrix,
  book: readonly string[],
): string | null {
  const pair = surface.fxCrossCode.toUpperCase();
  const hit = book.find(c => usdMarketPair(c) === pair);
  if (hit) return hit;
  const tag = surface.surfaceTag.toUpperCase();
  return book.find(c => tag.includes(usdMarketPair(c))) ?? null;
}

export function chunkIds<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export const FX_VOL_PULL_AXES: { xAxis: SurfaceAxis; yAxis: SurfaceAxis }[] = [
  { xAxis: 'Tenor', yAxis: 'Delta' },
  { xAxis: 'Date', yAxis: 'Delta' },
];

export function surfaceHasGrid(surface: VolSurfaceMatrix): boolean {
  return (
    surface.xLabels.length > 0
    && surface.yLabels.length > 0
    && surface.values.some(row => row.some(v => v != null && Number.isFinite(v)))
  );
}

export type StoredIpaVolSurface = VolSurfaceMatrix & {
  pulledAt: string;
  xAxis: SurfaceAxis;
  yAxis: SurfaceAxis;
};

export function readStoredIpaVolSurface(
  bundle?: FxMarketRatesBundle | null,
): StoredIpaVolSurface | null {
  const raw = bundle?.parameters?.ipaVolSurface;
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<StoredIpaVolSurface>;
  if (!Array.isArray(s.xLabels) || !Array.isArray(s.yLabels) || !Array.isArray(s.values)) {
    return null;
  }
  return {
    surfaceTag: typeof s.surfaceTag === 'string' ? s.surfaceTag : '',
    fxCrossCode: typeof s.fxCrossCode === 'string' ? s.fxCrossCode : '',
    xLabels: s.xLabels.map(v => String(v)),
    yLabels: s.yLabels.map(v => String(v)),
    values: s.values.map(row =>
      (Array.isArray(row) ? row : []).map(v =>
        typeof v === 'number' && Number.isFinite(v) ? v : null,
      ),
    ),
    errorMessage: typeof s.errorMessage === 'string' ? s.errorMessage : '',
    pulledAt: typeof s.pulledAt === 'string' ? s.pulledAt : '',
    xAxis: s.xAxis === 'Date' || s.xAxis === 'Tenor' || s.xAxis === 'Strike' || s.xAxis === 'Delta'
      ? s.xAxis
      : 'Tenor',
    yAxis: s.yAxis === 'Date' || s.yAxis === 'Tenor' || s.yAxis === 'Strike' || s.yAxis === 'Delta'
      ? s.yAxis
      : 'Delta',
  };
}

export function curveError(curves: readonly ForwardCurveQuote[]): string | null {
  const msg = curves.map(c => c.errorMessage).find(m => m.trim());
  return msg || null;
}
