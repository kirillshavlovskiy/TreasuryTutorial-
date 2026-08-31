import { isIsoDate } from "./isoDates";
import { asFiniteNumber, asString, isRecord } from "./refinitivHttp";

export const REFINITIV_SURFACES_URL =
  "https://api.refinitiv.com/data/quantitative-analytics-curves-and-surfaces/v1/surfaces";

export type SurfaceAxis = "Date" | "Strike" | "Delta" | "Tenor";
export type SurfaceFormat = "Matrix" | "List";

export interface FxVolSurfaceUniverseItem {
  underlyingType: "Fx";
  surfaceTag: string;
  underlyingDefinition: { fxCrossCode: string };
  surfaceLayout: { format: SurfaceFormat };
  surfaceParameters: {
    xAxis: SurfaceAxis;
    yAxis: SurfaceAxis;
    calculationDate?: string;
    returnAtm?: boolean;
  };
}

export interface VolSurfacesInput {
  universe: FxVolSurfaceUniverseItem[];
}

export interface VolSurfaceMatrix {
  surfaceTag: string;
  fxCrossCode: string;
  xLabels: string[];
  yLabels: string[];
  values: (number | null)[][];
  errorMessage: string;
}

export interface VolSurfacesResult {
  surfaces: VolSurfaceMatrix[];
  raw: unknown;
}

const AXES = new Set<SurfaceAxis>(["Date", "Strike", "Delta", "Tenor"]);

function parseAxis(value: unknown, field: string, fallback: SurfaceAxis): SurfaceAxis {
  const raw = asString(value) ?? fallback;
  if (!AXES.has(raw as SurfaceAxis)) {
    throw new Error(`${field} must be Date, Strike, Delta, or Tenor`);
  }
  return raw as SurfaceAxis;
}

function parseCalculationDate(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const day = raw.slice(0, 10);
  if (!isIsoDate(day)) throw new Error("calculationDate must be YYYY-MM-DD");
  return raw.includes("T") ? raw : `${day}T00:00:00Z`;
}

function parseUniverseItem(raw: unknown, index: number): FxVolSurfaceUniverseItem {
  if (!isRecord(raw)) throw new Error(`universe[${index}] must be an object`);
  const underlyingType = asString(raw.underlyingType) ?? "Fx";
  if (underlyingType !== "Fx") {
    throw new Error(`universe[${index}].underlyingType must be Fx`);
  }
  const underlying = isRecord(raw.underlyingDefinition) ? raw.underlyingDefinition : raw;
  const fxCrossCode = (asString(underlying.fxCrossCode) ?? "").toUpperCase();
  if (!/^[A-Z]{6}$/.test(fxCrossCode)) {
    throw new Error(`universe[${index}].underlyingDefinition.fxCrossCode must be a 6-letter pair`);
  }
  const layout = isRecord(raw.surfaceLayout) ? raw.surfaceLayout : {};
  const formatRaw = (asString(layout.format) ?? "Matrix") as SurfaceFormat;
  if (formatRaw !== "Matrix" && formatRaw !== "List") {
    throw new Error(`universe[${index}].surfaceLayout.format must be Matrix or List`);
  }
  const params = isRecord(raw.surfaceParameters) ? raw.surfaceParameters : {};
  const returnAtm =
    typeof params.returnAtm === "boolean"
      ? params.returnAtm
      : asString(params.returnAtm)?.toLowerCase() === "true"
        ? true
        : asString(params.returnAtm)?.toLowerCase() === "false"
          ? false
          : true;
  const item: FxVolSurfaceUniverseItem = {
    underlyingType: "Fx",
    surfaceTag: asString(raw.surfaceTag) ?? `FxVol-${fxCrossCode}`,
    underlyingDefinition: { fxCrossCode },
    surfaceLayout: { format: formatRaw },
    surfaceParameters: {
      xAxis: parseAxis(params.xAxis, `universe[${index}].surfaceParameters.xAxis`, "Date"),
      yAxis: parseAxis(params.yAxis, `universe[${index}].surfaceParameters.yAxis`, "Strike"),
      returnAtm,
    },
  };
  const calculationDate = parseCalculationDate(params.calculationDate);
  if (calculationDate) item.surfaceParameters.calculationDate = calculationDate;
  return item;
}

function parseCompactSpec(raw: Record<string, unknown>): FxVolSurfaceUniverseItem {
  return parseUniverseItem(
    {
      underlyingType: "Fx",
      surfaceTag: raw.surfaceTag,
      underlyingDefinition: { fxCrossCode: raw.fxCrossCode },
      surfaceLayout: { format: raw.format ?? "Matrix" },
      surfaceParameters: {
        xAxis: raw.xAxis ?? "Date",
        yAxis: raw.yAxis ?? "Strike",
        calculationDate: raw.calculationDate,
        returnAtm: raw.returnAtm ?? true,
      },
    },
    0
  );
}

export function parseVolSurfacesRequest(raw: unknown): VolSurfacesInput {
  if (!isRecord(raw)) throw new Error("Request body must be a JSON object");
  if (Array.isArray(raw.universe)) {
    if (raw.universe.length === 0) throw new Error("universe must be a non-empty array");
    if (raw.universe.length > 5) throw new Error("universe is limited to 5 surfaces");
    return { universe: raw.universe.map((item, i) => parseUniverseItem(item, i)) };
  }
  if (Array.isArray(raw.surfaces)) {
    if (raw.surfaces.length === 0) throw new Error("surfaces must be a non-empty array");
    if (raw.surfaces.length > 5) throw new Error("surfaces is limited to 5");
    return {
      universe: raw.surfaces.map((item, i) => {
        if (!isRecord(item)) throw new Error(`surfaces[${i}] must be an object`);
        return parseCompactSpec(item);
      }),
    };
  }
  return { universe: [parseCompactSpec(raw)] };
}

export function buildVolSurfacesRequest(input: VolSurfacesInput): Record<string, unknown> {
  return {
    universe: input.universe.map((item) => ({
      underlyingType: item.underlyingType,
      surfaceTag: item.surfaceTag,
      underlyingDefinition: item.underlyingDefinition,
      surfaceLayout: item.surfaceLayout,
      surfaceParameters: item.surfaceParameters,
    })),
  };
}

/** FX vol matrix from the IPA surfaces sample (Date × Strike, ATM included). */
export function fxVolSurfaceRequest(
  fxCrossCode: string,
  calculationDate?: string
): VolSurfacesInput {
  return parseVolSurfacesRequest({
    fxCrossCode,
    surfaceTag: `FxVol-${fxCrossCode.toUpperCase()}`,
    xAxis: "Date",
    yAxis: "Strike",
    returnAtm: true,
    ...(calculationDate ? { calculationDate } : {}),
  });
}

function cellNumber(value: unknown): number | null {
  const n = asFiniteNumber(value);
  return n === undefined ? null : n;
}

function parseMatrix(
  surface: unknown,
  surfaceTag: string,
  fxCrossCode: string,
  errorMessage: string
): VolSurfaceMatrix {
  if (!Array.isArray(surface) || surface.length === 0) {
    return {
      surfaceTag,
      fxCrossCode,
      xLabels: [],
      yLabels: [],
      values: [],
      errorMessage: errorMessage || "Refinitiv returned an empty surface",
    };
  }
  const header = Array.isArray(surface[0]) ? surface[0] : [];
  const xLabels = header.slice(1).map((v) => (v == null ? "" : String(v)));
  const yLabels: string[] = [];
  const values: (number | null)[][] = [];
  for (let i = 1; i < surface.length; i++) {
    const row = Array.isArray(surface[i]) ? surface[i] : [];
    yLabels.push(row[0] == null ? "" : String(row[0]));
    values.push(xLabels.map((_, j) => cellNumber(row[j + 1])));
  }
  return { surfaceTag, fxCrossCode, xLabels, yLabels, values, errorMessage };
}

export function parseVolSurfacesResponse(payload: unknown): VolSurfacesResult {
  if (!isRecord(payload)) throw new Error("Refinitiv returned a non-object body");
  if (isRecord(payload.error)) {
    const message = asString(payload.error.message) ?? "Refinitiv surfaces error";
    throw new Error(message);
  }
  const data = Array.isArray(payload.data) ? payload.data : [];
  const surfaces = data.map((row, i) => {
    if (!isRecord(row)) {
      return {
        surfaceTag: `Surface_${i + 1}`,
        fxCrossCode: "",
        xLabels: [],
        yLabels: [],
        values: [],
        errorMessage: "Invalid surface row",
      };
    }
    const underlying = isRecord(row.underlyingDefinition) ? row.underlyingDefinition : {};
    const errorMessage =
      asString(row.errorMessage) ??
      (isRecord(row.error) ? asString(row.error.message) : undefined) ??
      "";
    return parseMatrix(
      row.surface,
      asString(row.surfaceTag) ?? `Surface_${i + 1}`,
      asString(underlying.fxCrossCode) ?? "",
      errorMessage
    );
  });
  return { surfaces, raw: payload };
}
