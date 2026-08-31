import {
  parseForwardCurvesRequest,
  type ForwardCurveQuote,
  type ForwardCurvesInput,
} from '@/lib/refinitivForwardCurves';
import {
  fxVolSurfaceRequest,
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

const INDEX_BY_CCY: Record<string, { indexName: string; name: string }> = {
  EUR: { indexName: 'EURIBOR', name: 'EUR EURIBOR Swap ZC Curve' },
  USD: { indexName: 'SOFR', name: 'USD SOFR Swap ZC Curve' },
  GBP: { indexName: 'SONIA', name: 'GBP SONIA Swap ZC Curve' },
  JPY: { indexName: 'TONAR', name: 'JPY TONAR Swap ZC Curve' },
  CHF: { indexName: 'SARON', name: 'CHF SARON Swap ZC Curve' },
  AUD: { indexName: 'AONIA', name: 'AUD AONIA Swap ZC Curve' },
  CAD: { indexName: 'CORRA', name: 'CAD CORRA Swap ZC Curve' },
  MXN: { indexName: 'TIIE', name: 'MXN TIIE Swap ZC Curve' },
  PLN: { indexName: 'WIBOR', name: 'PLN WIBOR Swap ZC Curve' },
  TRY: { indexName: 'TLREF', name: 'TRY TLREF Swap ZC Curve' },
};

export function swapZcSpec(ccy: string): { indexName: string; name: string } {
  const key = ccy.toUpperCase();
  return INDEX_BY_CCY[key] ?? {
    indexName: key,
    name: `${key} Swap ZC Curve`,
  };
}

export function swapZcCurveRequest(
  ccy: string,
  valuationDate = todayIso(),
): ForwardCurvesInput {
  const spec = swapZcSpec(ccy);
  return parseForwardCurvesRequest({
    currency: ccy.toUpperCase(),
    indexName: spec.indexName,
    name: spec.name,
    discountingTenor: 'OIS',
    indexTenor: '3M',
    forwardCurveTag: `${ccy.toUpperCase()}Fwd`,
    forwardStartDate: valuationDate,
    forwardCurveTenors: [...MARKET_PULL_TENORS],
    valuationDate,
  });
}

export function dualCcyCurveRequest(
  fcy: string,
  valuationDate = todayIso(),
): ForwardCurvesInput {
  const fcyReq = swapZcCurveRequest(fcy, valuationDate);
  const usdReq = swapZcCurveRequest('USD', valuationDate);
  return { universe: [...fcyReq.universe, ...usdReq.universe] };
}

export function tenorToMonths(tenor: string): number | null {
  const t = tenor.trim().toUpperCase();
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

export function fxVolPullRequest(ccy: string, calculationDate = todayIso()) {
  return fxVolSurfaceRequest(usdMarketPair(ccy), calculationDate);
}

export function curveError(curves: readonly ForwardCurveQuote[]): string | null {
  const msg = curves.map(c => c.errorMessage).find(m => m.trim());
  return msg || null;
}
