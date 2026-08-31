import { isIsoDate } from "./isoDates";
import { asString, isRecord } from "./refinitivHttp";

export const REFINITIV_FORWARD_CURVES_URL =
  "https://api.refinitiv.com/data/quantitative-analytics-curves-and-surfaces/v1/curves/forward-curves";

/** Default pillar list from the IPA forward-curves samples. */
export const DEFAULT_FORWARD_CURVE_TENORS = [
  "0D",
  "1D",
  "2D",
  "3M",
  "6M",
  "9M",
  "1Y",
  "2Y",
  "3Y",
  "4Y",
  "5Y",
  "6Y",
  "7Y",
  "8Y",
  "9Y",
  "10Y",
  "15Y",
  "20Y",
  "25Y",
] as const;

export interface SwapZcCurveDefinition {
  currency: string;
  indexName: string;
  name: string;
  discountingTenor: string;
}

export interface ForwardCurveDefinition {
  indexTenor: string;
  forwardCurveTag: string;
  forwardStartDate?: string;
  forwardStartTenor?: string;
  forwardCurveTenors: string[];
}

export interface ForwardCurveUniverseItem {
  curveDefinition: SwapZcCurveDefinition;
  curveParameters?: { valuationDate?: string };
  forwardCurveDefinitions: ForwardCurveDefinition[];
}

export interface ForwardCurvesInput {
  universe: ForwardCurveUniverseItem[];
}

export interface ForwardCurvePoint {
  tenor: string;
  startDate: string;
  endDate: string;
  ratePercent: number | null;
  discountFactor: number | null;
}

export interface ForwardCurveQuote {
  forwardCurveTag: string;
  currency: string;
  indexName: string;
  indexTenor: string;
  errorMessage: string;
  points: ForwardCurvePoint[];
}

export interface ForwardCurvesResult {
  curves: ForwardCurveQuote[];
  raw: unknown;
}

function requireTenor(value: unknown, field: string): string {
  const raw = asString(value);
  if (!raw) throw new Error(`${field} is required`);
  return raw;
}

function parseTenors(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...DEFAULT_FORWARD_CURVE_TENORS];
  }
  if (raw.length > 40) throw new Error(`${field} is limited to 40 tenors`);
  const tenors = raw.map((item, i) => {
    const t = asString(item);
    if (!t) throw new Error(`${field}[${i}] must be a tenor or ISO date`);
    return t;
  });
  return tenors;
}

function parseCurveDefinition(raw: unknown): SwapZcCurveDefinition {
  if (!isRecord(raw)) throw new Error("curveDefinition is required");
  const currency = asString(raw.currency)?.toUpperCase();
  const indexName = asString(raw.indexName);
  const name = asString(raw.name);
  const discountingTenor = asString(raw.discountingTenor) ?? "OIS";
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error("curveDefinition.currency must be a 3-letter code");
  }
  if (!indexName) throw new Error("curveDefinition.indexName is required");
  if (!name) throw new Error("curveDefinition.name is required");
  return { currency, indexName, name, discountingTenor };
}

function parseForwardCurveDefinition(
  raw: unknown,
  index: number
): ForwardCurveDefinition {
  if (!isRecord(raw)) {
    throw new Error(`forwardCurveDefinitions[${index}] must be an object`);
  }
  const indexTenor = requireTenor(raw.indexTenor, `forwardCurveDefinitions[${index}].indexTenor`);
  const forwardStartDate = asString(raw.forwardStartDate);
  const forwardStartTenor = asString(raw.forwardStartTenor);
  if (forwardStartDate && !isIsoDate(forwardStartDate.slice(0, 10))) {
    throw new Error(
      `forwardCurveDefinitions[${index}].forwardStartDate must be YYYY-MM-DD`
    );
  }
  if (!forwardStartDate && !forwardStartTenor) {
    throw new Error(
      `forwardCurveDefinitions[${index}] needs forwardStartDate or forwardStartTenor`
    );
  }
  const def: ForwardCurveDefinition = {
    indexTenor,
    forwardCurveTag: asString(raw.forwardCurveTag) ?? `Forward_${index + 1}`,
    forwardCurveTenors: parseTenors(
      raw.forwardCurveTenors,
      `forwardCurveDefinitions[${index}].forwardCurveTenors`
    ),
  };
  if (forwardStartDate) def.forwardStartDate = forwardStartDate.slice(0, 10);
  if (forwardStartTenor) def.forwardStartTenor = forwardStartTenor;
  return def;
}

function parseUniverseItem(raw: unknown, index: number): ForwardCurveUniverseItem {
  if (!isRecord(raw)) throw new Error(`universe[${index}] must be an object`);
  if (!Array.isArray(raw.forwardCurveDefinitions) || raw.forwardCurveDefinitions.length === 0) {
    throw new Error(`universe[${index}].forwardCurveDefinitions must be a non-empty array`);
  }
  if (raw.forwardCurveDefinitions.length > 10) {
    throw new Error(`universe[${index}].forwardCurveDefinitions is limited to 10 curves`);
  }
  const item: ForwardCurveUniverseItem = {
    curveDefinition: parseCurveDefinition(raw.curveDefinition),
    forwardCurveDefinitions: raw.forwardCurveDefinitions.map((d, i) =>
      parseForwardCurveDefinition(d, i)
    ),
  };
  if (isRecord(raw.curveParameters)) {
    const valuationDate = asString(raw.curveParameters.valuationDate);
    if (valuationDate) {
      if (!isIsoDate(valuationDate.slice(0, 10))) {
        throw new Error(`universe[${index}].curveParameters.valuationDate must be YYYY-MM-DD`);
      }
      item.curveParameters = { valuationDate: valuationDate.slice(0, 10) };
    }
  }
  return item;
}

function parseCompactSpec(raw: Record<string, unknown>): ForwardCurveUniverseItem {
  const indexTenor = requireTenor(raw.indexTenor, "indexTenor");
  const forwardStartDate = asString(raw.forwardStartDate);
  const forwardStartTenor = asString(raw.forwardStartTenor);
  const def: ForwardCurveDefinition = {
    indexTenor,
    forwardCurveTag: asString(raw.forwardCurveTag) ?? "ForwardTag",
    forwardCurveTenors: parseTenors(raw.forwardCurveTenors, "forwardCurveTenors"),
  };
  if (forwardStartDate) {
    if (!isIsoDate(forwardStartDate.slice(0, 10))) {
      throw new Error("forwardStartDate must be YYYY-MM-DD");
    }
    def.forwardStartDate = forwardStartDate.slice(0, 10);
  }
  if (forwardStartTenor) def.forwardStartTenor = forwardStartTenor;
  if (!def.forwardStartDate && !def.forwardStartTenor) {
    throw new Error("Provide forwardStartDate or forwardStartTenor");
  }
  const item: ForwardCurveUniverseItem = {
    curveDefinition: parseCurveDefinition({
      currency: raw.currency ?? "EUR",
      indexName: raw.indexName ?? "EURIBOR",
      name: raw.name ?? "EUR EURIBOR Swap ZC Curve",
      discountingTenor: raw.discountingTenor ?? "OIS",
    }),
    forwardCurveDefinitions: [def],
  };
  const valuationDate = asString(raw.valuationDate);
  if (valuationDate) {
    if (!isIsoDate(valuationDate.slice(0, 10))) {
      throw new Error("valuationDate must be YYYY-MM-DD");
    }
    item.curveParameters = { valuationDate: valuationDate.slice(0, 10) };
  }
  return item;
}

export function parseForwardCurvesRequest(raw: unknown): ForwardCurvesInput {
  if (!isRecord(raw)) throw new Error("Request body must be a JSON object");
  if (Array.isArray(raw.universe)) {
    if (raw.universe.length === 0) throw new Error("universe must be a non-empty array");
    if (raw.universe.length > 5) throw new Error("universe is limited to 5 curve families");
    return { universe: raw.universe.map((item, i) => parseUniverseItem(item, i)) };
  }
  if (Array.isArray(raw.curves)) {
    if (raw.curves.length === 0) throw new Error("curves must be a non-empty array");
    if (raw.curves.length > 5) throw new Error("curves is limited to 5 families");
    return {
      universe: raw.curves.map((item, i) => {
        if (!isRecord(item)) throw new Error(`curves[${i}] must be an object`);
        return parseCompactSpec(item);
      }),
    };
  }
  return { universe: [parseCompactSpec(raw)] };
}

export function buildForwardCurvesRequest(input: ForwardCurvesInput): Record<string, unknown> {
  return {
    universe: input.universe.map((item) => {
      const row: Record<string, unknown> = {
        curveDefinition: item.curveDefinition,
        forwardCurveDefinitions: item.forwardCurveDefinitions.map((d) => {
          const def: Record<string, unknown> = {
            indexTenor: d.indexTenor,
            forwardCurveTag: d.forwardCurveTag,
            forwardCurveTenors: d.forwardCurveTenors,
          };
          if (d.forwardStartDate) def.forwardStartDate = d.forwardStartDate;
          if (d.forwardStartTenor) def.forwardStartTenor = d.forwardStartTenor;
          return def;
        }),
      };
      if (item.curveParameters) row.curveParameters = item.curveParameters;
      return row;
    }),
  };
}

/** EUR 3M forwards from an explicit start date (first IPA sample). */
export function euribor3mFromDate(forwardStartDate: string): ForwardCurvesInput {
  return parseForwardCurvesRequest({
    currency: "EUR",
    indexName: "EURIBOR",
    name: "EUR EURIBOR Swap ZC Curve",
    discountingTenor: "OIS",
    indexTenor: "3M",
    forwardCurveTag: "ForwardTag",
    forwardStartDate,
  });
}

/** EUR 6M forwards starting 3M ahead (swap / forward-start IPA sample). */
export function euribor6mFrom3mTenor(): ForwardCurvesInput {
  return parseForwardCurvesRequest({
    currency: "EUR",
    indexName: "EURIBOR",
    name: "EUR EURIBOR Swap ZC Curve",
    discountingTenor: "OIS",
    indexTenor: "6M",
    forwardCurveTag: "ForwardTag",
    forwardStartTenor: "3M",
  });
}

function pointFromRaw(raw: unknown): ForwardCurvePoint | null {
  if (!isRecord(raw)) return null;
  const tenor = asString(raw.tenor) ?? asString(raw.endDate) ?? "";
  const startDate = asString(raw.startDate) ?? "";
  const endDate = asString(raw.endDate) ?? "";
  const rateRaw = raw.ratePercent ?? raw.rate;
  const rate = asString(rateRaw)
    ? Number(rateRaw)
    : typeof rateRaw === "number"
      ? rateRaw
      : null;
  const dfRaw = raw.discountFactor ?? raw.df;
  const df = asString(dfRaw)
    ? Number(dfRaw)
    : typeof dfRaw === "number"
      ? dfRaw
      : null;
  return {
    tenor,
    startDate,
    endDate,
    ratePercent: rate !== null && Number.isFinite(rate) ? rate : null,
    discountFactor: df !== null && Number.isFinite(df) ? df : null,
  };
}

function quotesFromDataItem(
  item: Record<string, unknown>,
  familyDef: Record<string, unknown>
): ForwardCurveQuote[] {
  const currency = asString(familyDef.currency) ?? "";
  const indexName = asString(familyDef.indexName) ?? "";
  const familyError =
    asString(item.errorMessage) ??
    (isRecord(item.error) ? asString(item.error.message) : undefined) ??
    "";

  const buckets = Array.isArray(item.forwardCurves)
    ? item.forwardCurves
    : Array.isArray(item.curvePoints)
      ? [item]
      : [];

  if (buckets.length === 0) {
    return [
      {
        forwardCurveTag: asString(item.curveTag) ?? "ForwardTag",
        currency,
        indexName,
        indexTenor: "",
        errorMessage: familyError || "Refinitiv returned no forward curve points",
        points: [],
      },
    ];
  }

  return buckets.map((bucket, i) => {
    if (!isRecord(bucket)) {
      return {
        forwardCurveTag: `Forward_${i + 1}`,
        currency,
        indexName,
        indexTenor: "",
        errorMessage: "Invalid forward curve row",
        points: [],
      };
    }
    const def = isRecord(bucket.curveDefinition) ? bucket.curveDefinition : {};
    const pointsRaw = Array.isArray(bucket.curvePoints) ? bucket.curvePoints : [];
    const errorMessage =
      asString(bucket.errorMessage) ??
      (isRecord(bucket.error) ? asString(bucket.error.message) : undefined) ??
      familyError;
    return {
      forwardCurveTag: asString(def.forwardCurveTag) ?? asString(bucket.curveTag) ?? `Forward_${i + 1}`,
      currency,
      indexName,
      indexTenor: asString(def.indexTenor) ?? "",
      errorMessage: errorMessage ?? "",
      points: pointsRaw.map(pointFromRaw).filter((p): p is ForwardCurvePoint => p !== null),
    };
  });
}

export function parseForwardCurvesResponse(payload: unknown): ForwardCurvesResult {
  if (!isRecord(payload)) throw new Error("Refinitiv returned a non-object body");
  if (isRecord(payload.error)) {
    const message = asString(payload.error.message) ?? "Refinitiv forward-curves error";
    throw new Error(message);
  }
  const data = Array.isArray(payload.data) ? payload.data : [];
  const curves = data.flatMap((row) => {
    if (!isRecord(row)) return [];
    const familyDef = isRecord(row.curveDefinition) ? row.curveDefinition : {};
    return quotesFromDataItem(row, familyDef);
  });
  return { curves, raw: payload };
}
