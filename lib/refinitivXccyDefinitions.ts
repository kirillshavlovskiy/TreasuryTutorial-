import { asString, isRecord } from './refinitivHttp';

export const REFINITIV_XCCY_DEFINITIONS_URL =
  'https://api.refinitiv.com/data/quantitative-analytics-curves-and-surfaces/v1/curves/cross-currency-curves/curve-definitions';

export interface XccyDefinitionQuery {
  baseCurrency: string;
  quotedCurrency: string;
}

export interface XccyDefinitionsInput {
  universe: XccyDefinitionQuery[];
}

export interface XccyPublishedDefinition {
  id: string;
  name: string;
  baseCurrency: string;
  quotedCurrency: string;
  baseIndexName: string;
  quotedIndexName: string;
  mainConstituentAssetClass: string;
  source: string;
  isFallback: boolean;
  isNonDeliverable: boolean;
}

export interface XccyDefinitionRow {
  baseCurrency: string;
  quotedCurrency: string;
  errorMessage: string;
  definitions: XccyPublishedDefinition[];
}

export interface XccyDefinitionsResult {
  rows: XccyDefinitionRow[];
  raw: unknown;
}

function requireCcy(value: unknown, field: string): string {
  const raw = asString(value)?.toUpperCase();
  if (!raw || !/^[A-Z]{3}$/.test(raw)) {
    throw new Error(`${field} must be a 3-letter currency`);
  }
  return raw;
}

function parseQuery(raw: unknown, index: number): XccyDefinitionQuery {
  if (!isRecord(raw)) throw new Error(`universe[${index}] must be an object`);
  const inner = isRecord(raw.curveDefinition) ? raw.curveDefinition : raw;
  return {
    baseCurrency: requireCcy(inner.baseCurrency, `universe[${index}].baseCurrency`),
    quotedCurrency: requireCcy(inner.quotedCurrency, `universe[${index}].quotedCurrency`),
  };
}

export function parseXccyDefinitionsRequest(raw: unknown): XccyDefinitionsInput {
  if (!isRecord(raw)) throw new Error('Request body must be a JSON object');
  const universe = Array.isArray(raw.universe) ? raw.universe : null;
  if (!universe || universe.length === 0) {
    throw new Error('universe must be a non-empty array');
  }
  if (universe.length > 5) {
    throw new Error('universe is limited to 5 cross-currency definition queries');
  }
  return { universe: universe.map(parseQuery) };
}

export function buildXccyDefinitionsRequest(
  input: XccyDefinitionsInput,
): Record<string, unknown> {
  return {
    universe: input.universe.map(item => ({
      baseCurrency: item.baseCurrency,
      quotedCurrency: item.quotedCurrency,
    })),
  };
}

function publishedFromRaw(raw: unknown): XccyPublishedDefinition | null {
  if (!isRecord(raw)) return null;
  const baseCurrency = asString(raw.baseCurrency)?.toUpperCase() ?? '';
  const quotedCurrency = asString(raw.quotedCurrency)?.toUpperCase() ?? '';
  if (!baseCurrency || !quotedCurrency) return null;
  return {
    id: asString(raw.id) ?? '',
    name: asString(raw.name) ?? '',
    baseCurrency,
    quotedCurrency,
    baseIndexName: (asString(raw.baseIndexName) ?? '').toUpperCase(),
    quotedIndexName: (asString(raw.quotedIndexName) ?? '').toUpperCase(),
    mainConstituentAssetClass: asString(raw.mainConstituentAssetClass) ?? '',
    source: asString(raw.source) ?? '',
    isFallback: raw.isFallbackForFxCurveDefinition === true,
    isNonDeliverable: raw.isNonDeliverable === true,
  };
}

function rowFromRaw(row: unknown): XccyDefinitionRow {
  if (!isRecord(row)) {
    return {
      baseCurrency: '',
      quotedCurrency: '',
      errorMessage: 'Invalid definition row',
      definitions: [],
    };
  }
  const defsRaw = Array.isArray(row.curveDefinitions) ? row.curveDefinitions : [];
  const definitions = defsRaw
    .map(publishedFromRaw)
    .filter((d): d is XccyPublishedDefinition => d != null);
  const first = definitions[0];
  const errorMessage =
    asString(row.errorMessage)
    ?? (isRecord(row.error) ? asString(row.error.message) : undefined)
    ?? '';
  return {
    baseCurrency: first?.baseCurrency ?? '',
    quotedCurrency: first?.quotedCurrency ?? '',
    errorMessage,
    definitions,
  };
}

export function parseXccyDefinitionsResponse(payload: unknown): XccyDefinitionsResult {
  if (!isRecord(payload)) throw new Error('Refinitiv returned a non-object body');
  if (isRecord(payload.error)) {
    const message = asString(payload.error.message) ?? 'Refinitiv curve-definitions error';
    throw new Error(message);
  }
  const data = Array.isArray(payload.data) ? payload.data : [];
  return {
    rows: data.map(row => rowFromRaw(row)),
    raw: payload,
  };
}

/** Prefer a live Swap cross; use FxForward fallback only when that is all IPA has. */
export function pickXccyDefinition(
  defs: readonly XccyPublishedDefinition[],
): XccyPublishedDefinition | null {
  if (defs.length === 0) return null;
  const rank = (d: XccyPublishedDefinition) => {
    let score = 0;
    if (!d.isFallback) score += 8;
    if (/swap/i.test(d.mainConstituentAssetClass)) score += 4;
    if (/fxforward/i.test(d.mainConstituentAssetClass)) score += 1;
    if (d.baseIndexName && d.quotedIndexName) score += 1;
    return score;
  };
  return [...defs].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}
