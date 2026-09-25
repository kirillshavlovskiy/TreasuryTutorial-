import { asFiniteNumber, asString, isRecord } from './refinitivHttp';

export const REFINITIV_XCCY_CURVES_URL =
  'https://api.refinitiv.com/data/quantitative-analytics-curves-and-surfaces/v1/curves/cross-currency-curves/curves';

export interface XccyCurveDefinition {
  baseCurrency: string;
  baseIndexName: string;
  quotedCurrency: string;
  quotedIndexName: string;
  curveTenors?: string[];
  mainConstituentAssetClass?: string;
  name?: string;
  source?: string;
  id?: string;
}

export interface XccyCurvesInput {
  universe: { curveDefinition: XccyCurveDefinition }[];
}

export interface XccyCurvePoint {
  tenor: string;
  startDate: string;
  endDate: string;
  swapPoint: { bid: number | null; ask: number | null; mid: number | null };
  outright: { bid: number | null; ask: number | null; mid: number | null };
}

export interface XccyCurveQuote {
  baseCurrency: string;
  quotedCurrency: string;
  baseIndexName: string;
  quotedIndexName: string;
  name: string;
  fxSwapPointScalingFactor: number;
  fxCrossScalingFactor: number;
  valuationDate: string;
  errorMessage: string;
  points: XccyCurvePoint[];
}

export interface XccyCurvesResult {
  curves: XccyCurveQuote[];
  raw: unknown;
}

function requireCcy(value: unknown, field: string): string {
  const raw = asString(value)?.toUpperCase();
  if (!raw || !/^[A-Z]{3}$/.test(raw)) {
    throw new Error(`${field} must be a 3-letter currency`);
  }
  return raw;
}

function requireIndex(value: unknown, field: string): string {
  const raw = asString(value);
  if (!raw) throw new Error(`${field} is required`);
  return raw.toUpperCase();
}

function parseTenors(raw: unknown, field: string): string[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  return raw.map((item, i) => {
    const tenor = asString(item)?.trim().toUpperCase();
    if (!tenor) throw new Error(`${field}[${i}] must be a tenor`);
    return tenor;
  });
}

function parseDefinition(raw: unknown, index: number): XccyCurveDefinition {
  if (!isRecord(raw)) {
    throw new Error(`universe[${index}].curveDefinition must be an object`);
  }
  const curveTenors = parseTenors(
    raw.curveTenors,
    `universe[${index}].curveDefinition.curveTenors`,
  );
  const assetClass = asString(raw.mainConstituentAssetClass);
  const name = asString(raw.name);
  const source = asString(raw.source);
  const id = asString(raw.id);
  return {
    baseCurrency: requireCcy(raw.baseCurrency, `universe[${index}].curveDefinition.baseCurrency`),
    baseIndexName: requireIndex(raw.baseIndexName, `universe[${index}].curveDefinition.baseIndexName`),
    quotedCurrency: requireCcy(raw.quotedCurrency, `universe[${index}].curveDefinition.quotedCurrency`),
    quotedIndexName: requireIndex(
      raw.quotedIndexName,
      `universe[${index}].curveDefinition.quotedIndexName`,
    ),
    ...(curveTenors ? { curveTenors } : {}),
    ...(assetClass ? { mainConstituentAssetClass: assetClass } : {}),
    ...(name ? { name } : {}),
    ...(source ? { source } : {}),
    ...(id ? { id } : {}),
  };
}

export function parseXccyCurvesRequest(raw: unknown): XccyCurvesInput {
  if (!isRecord(raw)) throw new Error('Request body must be a JSON object');
  const universe = Array.isArray(raw.universe) ? raw.universe : null;
  if (!universe || universe.length === 0) {
    throw new Error('universe must be a non-empty array');
  }
  if (universe.length > 5) {
    throw new Error('universe is limited to 5 cross-currency curves');
  }
  return {
    universe: universe.map((item, i) => {
      if (!isRecord(item)) throw new Error(`universe[${i}] must be an object`);
      return {
        curveDefinition: parseDefinition(
          isRecord(item.curveDefinition) ? item.curveDefinition : item,
          i,
        ),
      };
    }),
  };
}

export function buildXccyCurvesRequest(input: XccyCurvesInput): Record<string, unknown> {
  return {
    universe: input.universe.map(item => {
      const d = item.curveDefinition;
      return {
        curveDefinition: {
          baseCurrency: d.baseCurrency,
          baseIndexName: d.baseIndexName,
          quotedCurrency: d.quotedCurrency,
          quotedIndexName: d.quotedIndexName,
          ...(d.curveTenors?.length ? { curveTenors: d.curveTenors } : {}),
        },
      };
    }),
  };
}

function sideFrom(raw: unknown): { bid: number | null; ask: number | null; mid: number | null } {
  if (!isRecord(raw)) return { bid: null, ask: null, mid: null };
  return {
    bid: asFiniteNumber(raw.bid) ?? null,
    ask: asFiniteNumber(raw.ask) ?? null,
    mid: asFiniteNumber(raw.mid) ?? null,
  };
}

function pointFromRaw(raw: unknown): XccyCurvePoint | null {
  if (!isRecord(raw)) return null;
  const tenor = asString(raw.tenor);
  if (!tenor) return null;
  return {
    tenor,
    startDate: asString(raw.startDate) ?? '',
    endDate: asString(raw.endDate) ?? '',
    swapPoint: sideFrom(raw.swapPoint),
    outright: sideFrom(raw.outright),
  };
}

function quoteFromRow(row: unknown, index: number): XccyCurveQuote {
  if (!isRecord(row)) {
    return {
      baseCurrency: '',
      quotedCurrency: '',
      baseIndexName: '',
      quotedIndexName: '',
      name: `Xccy_${index + 1}`,
      fxSwapPointScalingFactor: 10_000,
      fxCrossScalingFactor: 1,
      valuationDate: '',
      errorMessage: 'Invalid cross-currency row',
      points: [],
    };
  }
  const def = isRecord(row.curveDefinition) ? row.curveDefinition : {};
  const firstFrom = (raw: unknown): Record<string, unknown> => {
    if (!Array.isArray(raw) || !isRecord(raw[0])) return {};
    return raw[0];
  };
  const firstXccy = {
    ...firstFrom(row.curveDefinitions),
    ...firstFrom(def.curveDefinitions),
    ...firstFrom(def.crossCurrencyDefinitions),
  };
  const curve = isRecord(row.curve) ? row.curve : {};
  const params = isRecord(row.curveParameters) ? row.curveParameters : {};
  const errorMessage =
    asString(row.errorMessage)
    ?? (isRecord(row.error) ? asString(row.error.message) : undefined)
    ?? '';
  const pointsRaw = Array.isArray(curve.curvePoints) ? curve.curvePoints : [];
  return {
    baseCurrency: (asString(def.baseCurrency) ?? asString(firstXccy.baseCurrency) ?? '').toUpperCase(),
    quotedCurrency: (asString(def.quotedCurrency) ?? asString(firstXccy.quotedCurrency) ?? '').toUpperCase(),
    baseIndexName: (asString(def.baseIndexName) ?? asString(firstXccy.baseIndexName) ?? '').toUpperCase(),
    quotedIndexName: (asString(def.quotedIndexName) ?? asString(firstXccy.quotedIndexName) ?? '').toUpperCase(),
    name: asString(firstXccy.name) ?? `Xccy_${index + 1}`,
    fxSwapPointScalingFactor: asFiniteNumber(curve.fxSwapPointScalingFactor) ?? 10_000,
    fxCrossScalingFactor: asFiniteNumber(curve.fxCrossScalingFactor) ?? 1,
    valuationDate: asString(params.valuationDate) ?? '',
    errorMessage,
    points: pointsRaw
      .map(pointFromRaw)
      .filter((p): p is XccyCurvePoint => p !== null),
  };
}

export function parseXccyCurvesResponse(payload: unknown): XccyCurvesResult {
  if (!isRecord(payload)) throw new Error('Refinitiv returned a non-object body');
  if (isRecord(payload.error)) {
    const message = asString(payload.error.message) ?? 'Refinitiv cross-currency-curves error';
    throw new Error(message);
  }
  const data = Array.isArray(payload.data) ? payload.data : [];
  return {
    curves: data.map((row, i) => quoteFromRow(row, i)),
    raw: payload,
  };
}

export function xccyCurveUsable(curve?: XccyCurveQuote | null): boolean {
  if (!curve || curve.errorMessage.trim()) return false;
  return curve.points.some(
    p =>
      (p.swapPoint.mid != null && Number.isFinite(p.swapPoint.mid))
      || (p.outright.mid != null && Number.isFinite(p.outright.mid)),
  );
}
