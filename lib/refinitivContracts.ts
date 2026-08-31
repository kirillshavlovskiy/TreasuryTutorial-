import { isIsoDate } from "./isoDates";

export const REFINITIV_QAS_URL =
  "https://api.refinitiv.com/data/quantitative-analytics/v1/financial-contracts";

export const REFINITIV_QAS_FIELDS = [
  "InstrumentType",
  "InstrumentTag",
  "InstrumentDescription",
  "FxCrossCode",
  "SpotDate",
  "StartDate",
  "EndDate",
  "Tenor",
  "DeliveryDate",
  "OptionType",
  "CallPut",
  "BuySell",
  "Strike",
  "NotionalAmount",
  "NotionalCcy",
  "DomesticCcy",
  "ForeignCcy",
  "ErrorCode",
  "ErrorMessage",
  "ProcessingInformation",
  "MarketDataDate",
  "ValuationDate",
  "FxSpot",
  "FxOutright",
  "FxSwap",
  "AtmVolatilityPercent",
  "RiskReversal10DeltaPercent",
  "RiskReversal25DeltaPercent",
  "Butterfly10DeltaPercent",
  "Butterfly25DeltaPercent",
  "DomesticDepositRatePercent",
  "ForeignDepositRatePercent",
  "ImpliedVolatilityPercent",
  "BreakEvenPricePercent",
  "MarketValueInDomesticCcy",
  "MarketValueInForeignCcy",
  "PremiumPercent",
  "CashFlows",
  "DeltaPercent",
  "GammaPercent",
  "ThetaPercent",
  "VegaPercent",
  "RhoPercent",
  "ForwardDeltaPercent",
  "ForwardGammaPercent",
  "GearingPercent",
  "CharmPercent",
  "VannaPercent",
  "VolgaPercent",
  "ColorPercent",
  "SpeedPercent",
  "ZommaPercent",
  "UltimaPercent",
  "DualDeltaPercent",
  "DualGammaPercent",
  "DualThetaPercent",
] as const;

export type CallPut = "Call" | "Put";
export type BuySell = "Buy" | "Sell";
export type ExerciseStyle = "EURO" | "AMER";
export type BarrierMode = "American" | "European";
export type BarrierInOrOut = "In" | "Out";
export type BarrierUpOrDown = "Up" | "Down";
export type FxOptionStructure = "vanilla" | "barrier";

export interface BarrierSpec {
  barrierMode: BarrierMode;
  inOrOut: BarrierInOrOut;
  upOrDown: BarrierUpOrDown;
  level: number;
}

export interface FxOptionSpec {
  instrumentTag: string;
  fxCrossCode: string;
  structure: FxOptionStructure;
  callPut: CallPut;
  buySell: BuySell;
  /** Absolute strike. Mutually exclusive with strikeExpression. */
  strike?: number;
  /** IPA strikeExpression (ATMF, 25DC, 10%OTM). Mutually exclusive with strike. */
  strikeExpression?: string;
  endDate: string;
  notionalAmount: number;
  notionalCcy: string;
  exerciseStyle: ExerciseStyle;
  barrier?: BarrierSpec;
}

export interface PriceContractsInput {
  valuationDate: string;
  contracts: FxOptionSpec[];
}

export interface FxOptionQuote {
  instrumentTag: string;
  description: string;
  optionType: string;
  callPut: string;
  buySell: string;
  strike: number | null;
  endDate: string;
  notionalAmount: number | null;
  notionalCcy: string;
  domesticCcy: string;
  foreignCcy: string;
  errorCode: string;
  errorMessage: string;
  fxSpot: number | null;
  fxOutright: number | null;
  fxSwap: number | null;
  atmVolPercent: number | null;
  impliedVolPercent: number | null;
  rr25Percent: number | null;
  domesticDepositPercent: number | null;
  foreignDepositPercent: number | null;
  marketValueDomestic: number | null;
  marketValueForeign: number | null;
  premiumPercent: number | null;
  breakEvenPercent: number | null;
  deltaPercent: number | null;
  gammaPercent: number | null;
  thetaPercent: number | null;
  vegaPercent: number | null;
  rhoPercent: number | null;
  vannaPercent: number | null;
  volgaPercent: number | null;
  cashFlows: unknown;
  fields: Record<string, unknown>;
}

export interface PriceContractsResult {
  valuationDate: string;
  quotes: FxOptionQuote[];
}

const CALL_PUTS = new Set<CallPut>(["Call", "Put"]);
const BUY_SELLS = new Set<BuySell>(["Buy", "Sell"]);
const EXERCISE_STYLES = new Set<ExerciseStyle>(["EURO", "AMER"]);
const BARRIER_MODES = new Set<BarrierMode>(["American", "European"]);
const IN_OR_OUT = new Set<BarrierInOrOut>(["In", "Out"]);
const UP_OR_DOWN = new Set<BarrierUpOrDown>(["Up", "Down"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function requireIsoDate(value: unknown, field: string): string {
  const raw = asString(value);
  if (!raw || !isIsoDate(raw)) {
    throw new Error(`${field} must be an ISO date (YYYY-MM-DD)`);
  }
  return raw;
}

function parseBarrier(raw: unknown): BarrierSpec {
  if (!isRecord(raw)) throw new Error("barrier is required for barrier options");
  const barrierMode = asString(raw.barrierMode);
  const inOrOut = asString(raw.inOrOut);
  const upOrDown = asString(raw.upOrDown);
  const level = asFiniteNumber(raw.level);
  if (!barrierMode || !BARRIER_MODES.has(barrierMode as BarrierMode)) {
    throw new Error("barrier.barrierMode must be American or European");
  }
  if (!inOrOut || !IN_OR_OUT.has(inOrOut as BarrierInOrOut)) {
    throw new Error("barrier.inOrOut must be In or Out");
  }
  if (!upOrDown || !UP_OR_DOWN.has(upOrDown as BarrierUpOrDown)) {
    throw new Error("barrier.upOrDown must be Up or Down");
  }
  if (level === undefined || level <= 0) {
    throw new Error("barrier.level must be a positive number");
  }
  return {
    barrierMode: barrierMode as BarrierMode,
    inOrOut: inOrOut as BarrierInOrOut,
    upOrDown: upOrDown as BarrierUpOrDown,
    level,
  };
}

export function parseFxOptionSpec(raw: unknown, index: number): FxOptionSpec {
  if (!isRecord(raw)) throw new Error(`contracts[${index}] must be an object`);

  const callPut = asString(raw.callPut);
  const buySell = asString(raw.buySell);
  const strike = asFiniteNumber(raw.strike);
  const strikeExpression = asString(raw.strikeExpression);
  const notionalAmount = asFiniteNumber(raw.notionalAmount);
  const endDate = requireIsoDate(raw.endDate, `contracts[${index}].endDate`);
  const structureRaw = asString(raw.structure) ?? "vanilla";
  const exerciseStyle = (asString(raw.exerciseStyle) ?? "EURO") as ExerciseStyle;

  if (!callPut || !CALL_PUTS.has(callPut as CallPut)) {
    throw new Error(`contracts[${index}].callPut must be Call or Put`);
  }
  if (!buySell || !BUY_SELLS.has(buySell as BuySell)) {
    throw new Error(`contracts[${index}].buySell must be Buy or Sell`);
  }
  if (strike !== undefined && strikeExpression) {
    throw new Error(
      `contracts[${index}] cannot set both strike and strikeExpression`
    );
  }
  if ((strike === undefined || strike <= 0) && !strikeExpression) {
    throw new Error(
      `contracts[${index}] needs strike or strikeExpression (ATMF, 25DC, 25DP)`
    );
  }
  if (notionalAmount === undefined || notionalAmount <= 0) {
    throw new Error(`contracts[${index}].notionalAmount must be a positive number`);
  }
  if (structureRaw !== "vanilla" && structureRaw !== "barrier") {
    throw new Error(`contracts[${index}].structure must be vanilla or barrier`);
  }
  if (!EXERCISE_STYLES.has(exerciseStyle)) {
    throw new Error(`contracts[${index}].exerciseStyle must be EURO or AMER`);
  }

  const fxCrossCode = (asString(raw.fxCrossCode) ?? "EURUSD").toUpperCase();
  if (!/^[A-Z]{6}$/.test(fxCrossCode)) {
    throw new Error(`contracts[${index}].fxCrossCode must be a 6-letter pair`);
  }

  const spec: FxOptionSpec = {
    instrumentTag:
      asString(raw.instrumentTag) ?? `Option_${index + 1}`,
    fxCrossCode,
    structure: structureRaw,
    callPut: callPut as CallPut,
    buySell: buySell as BuySell,
    ...(strikeExpression
      ? { strikeExpression }
      : { strike: strike as number }),
    endDate,
    notionalAmount,
    notionalCcy: (asString(raw.notionalCcy) ?? "EUR").toUpperCase(),
    exerciseStyle,
  };

  if (structureRaw === "barrier") {
    spec.barrier = parseBarrier(raw.barrier);
  }

  return spec;
}

function assertEndDates(input: PriceContractsInput): PriceContractsInput {
  for (const [i, spec] of input.contracts.entries()) {
    if (spec.endDate < input.valuationDate) {
      throw new Error(`contracts[${i}].endDate must be on or after valuationDate`);
    }
  }
  return input;
}

export function parsePriceContractsInput(raw: unknown): PriceContractsInput {
  if (!isRecord(raw)) throw new Error("Request body must be a JSON object");
  const valuationDate = requireIsoDate(raw.valuationDate, "valuationDate");
  if (!Array.isArray(raw.contracts) || raw.contracts.length === 0) {
    throw new Error("contracts must be a non-empty array");
  }
  if (raw.contracts.length > 20) {
    throw new Error("contracts is limited to 20 instruments per request");
  }
  const contracts = raw.contracts.map((item, i) => parseFxOptionSpec(item, i));
  return assertEndDates({ valuationDate, contracts });
}

function parseNativeUniverseItem(raw: unknown, index: number): {
  spec: FxOptionSpec;
  valuationDate: string;
} {
  if (!isRecord(raw)) {
    throw new Error(`universe[${index}] must be an object`);
  }
  const instrumentType = asString(raw.instrumentType) ?? "Option";
  if (instrumentType !== "Option") {
    throw new Error(`universe[${index}].instrumentType must be Option`);
  }
  const def = raw.instrumentDefinition;
  if (!isRecord(def)) {
    throw new Error(`universe[${index}].instrumentDefinition is required`);
  }
  const underlying = isRecord(def.underlyingDefinition)
    ? def.underlyingDefinition
    : {};
  const pricing = isRecord(raw.pricingParameters) ? raw.pricingParameters : {};
  const hasBarrier = isRecord(def.barrierDefinition);
  const spec = parseFxOptionSpec(
    {
      instrumentTag: def.instrumentTag,
      fxCrossCode: underlying.fxCrossCode,
      structure: hasBarrier ? "barrier" : "vanilla",
      callPut: def.callPut,
      buySell: def.buySell,
      strike: def.strike,
      strikeExpression: def.strikeExpression,
      endDate: def.endDate,
      notionalAmount: def.notionalAmount,
      notionalCcy: def.notionalCcy,
      exerciseStyle: def.exerciseStyle,
      barrier: hasBarrier ? def.barrierDefinition : undefined,
    },
    index
  );
  return {
    spec,
    valuationDate: requireIsoDate(
      pricing.valuationDate,
      `universe[${index}].pricingParameters.valuationDate`
    ),
  };
}

export function isNativeQasBody(raw: unknown): boolean {
  return isRecord(raw) && Array.isArray(raw.universe);
}

export function parseNativeQasInput(raw: unknown): PriceContractsInput {
  if (!isRecord(raw) || !Array.isArray(raw.universe) || raw.universe.length === 0) {
    throw new Error("universe must be a non-empty array");
  }
  if (raw.universe.length > 20) {
    throw new Error("universe is limited to 20 instruments per request");
  }
  const parsed = raw.universe.map((item, i) => parseNativeUniverseItem(item, i));
  return assertEndDates({
    valuationDate: parsed[0].valuationDate,
    contracts: parsed.map((p) => p.spec),
  });
}

/** Accepts either the QAS financial-contracts body or `{ valuationDate, contracts }`. */
export function parsePriceRequest(raw: unknown): PriceContractsInput {
  return isNativeQasBody(raw) ? parseNativeQasInput(raw) : parsePriceContractsInput(raw);
}

export function buildQasUniverseItem(
  spec: FxOptionSpec,
  valuationDate: string
): Record<string, unknown> {
  // Key order matches the Refinitiv Quantitative Analytics sample body.
  const instrumentDefinition: Record<string, unknown> = {
    instrumentTag: spec.instrumentTag,
    underlyingType: "Fx",
    underlyingDefinition: { fxCrossCode: spec.fxCrossCode },
  };

  if (spec.structure === "barrier" && spec.barrier) {
    instrumentDefinition.barrierDefinition = {
      barrierMode: spec.barrier.barrierMode,
      inOrOut: spec.barrier.inOrOut,
      upOrDown: spec.barrier.upOrDown,
      level: spec.barrier.level,
    };
  }

  instrumentDefinition.endDate = spec.endDate;
  if (spec.strikeExpression) {
    instrumentDefinition.strikeExpression = spec.strikeExpression;
  } else {
    instrumentDefinition.strike = spec.strike;
  }
  instrumentDefinition.callPut = spec.callPut;
  instrumentDefinition.exerciseStyle = spec.exerciseStyle;
  instrumentDefinition.notionalAmount = spec.notionalAmount;
  instrumentDefinition.notionalCcy = spec.notionalCcy;
  instrumentDefinition.buySell = spec.buySell;

  return {
    instrumentType: "Option",
    instrumentDefinition,
    pricingParameters: { valuationDate },
  };
}

export function buildQasRequest(input: PriceContractsInput): Record<string, unknown> {
  return {
    fields: [...REFINITIV_QAS_FIELDS],
    outputs: ["Data", "Headers", "MarketData", "Statuses"],
    universe: input.contracts.map((spec) =>
      buildQasUniverseItem(spec, input.valuationDate)
    ),
  };
}

function headerNames(headers: unknown): string[] {
  if (!Array.isArray(headers)) return [];
  return headers.map((h) => {
    if (isRecord(h) && typeof h.name === "string") return h.name;
    return typeof h === "string" ? h : "";
  });
}

function rowToFields(names: string[], row: unknown): Record<string, unknown> {
  const values = Array.isArray(row) ? row : [];
  const fields: Record<string, unknown> = {};
  names.forEach((name, i) => {
    if (name) fields[name] = values[i];
  });
  return fields;
}

function fieldString(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function fieldNumber(fields: Record<string, unknown>, key: string): number | null {
  const v = asFiniteNumber(fields[key]);
  return v === undefined ? null : v;
}

export function quoteFromFields(fields: Record<string, unknown>): FxOptionQuote {
  return {
    instrumentTag: fieldString(fields, "InstrumentTag"),
    description: fieldString(fields, "InstrumentDescription"),
    optionType: fieldString(fields, "OptionType"),
    callPut: fieldString(fields, "CallPut"),
    buySell: fieldString(fields, "BuySell"),
    strike: fieldNumber(fields, "Strike"),
    endDate: fieldString(fields, "EndDate"),
    notionalAmount: fieldNumber(fields, "NotionalAmount"),
    notionalCcy: fieldString(fields, "NotionalCcy"),
    domesticCcy: fieldString(fields, "DomesticCcy"),
    foreignCcy: fieldString(fields, "ForeignCcy"),
    errorCode: fieldString(fields, "ErrorCode"),
    errorMessage: fieldString(fields, "ErrorMessage"),
    fxSpot: fieldNumber(fields, "FxSpot"),
    fxOutright: fieldNumber(fields, "FxOutright"),
    fxSwap: fieldNumber(fields, "FxSwap"),
    atmVolPercent: fieldNumber(fields, "AtmVolatilityPercent"),
    impliedVolPercent: fieldNumber(fields, "ImpliedVolatilityPercent"),
    rr25Percent: fieldNumber(fields, "RiskReversal25DeltaPercent"),
    domesticDepositPercent: fieldNumber(fields, "DomesticDepositRatePercent"),
    foreignDepositPercent: fieldNumber(fields, "ForeignDepositRatePercent"),
    marketValueDomestic: fieldNumber(fields, "MarketValueInDomesticCcy"),
    marketValueForeign: fieldNumber(fields, "MarketValueInForeignCcy"),
    premiumPercent: fieldNumber(fields, "PremiumPercent"),
    breakEvenPercent: fieldNumber(fields, "BreakEvenPricePercent"),
    deltaPercent: fieldNumber(fields, "DeltaPercent"),
    gammaPercent: fieldNumber(fields, "GammaPercent"),
    thetaPercent: fieldNumber(fields, "ThetaPercent"),
    vegaPercent: fieldNumber(fields, "VegaPercent"),
    rhoPercent: fieldNumber(fields, "RhoPercent"),
    vannaPercent: fieldNumber(fields, "VannaPercent"),
    volgaPercent: fieldNumber(fields, "VolgaPercent"),
    cashFlows: fields.CashFlows ?? null,
    fields,
  };
}

export function parseQasResponse(
  payload: unknown,
  valuationDate: string
): PriceContractsResult {
  if (!isRecord(payload)) {
    throw new Error("Refinitiv returned a non-object body");
  }
  if (isRecord(payload.error)) {
    const message =
      asString(payload.error.message) ?? "Refinitiv Quantitative Analytics error";
    throw new Error(message);
  }
  const names = headerNames(payload.headers);
  const data = Array.isArray(payload.data) ? payload.data : [];
  const quotes = data.map((row) => quoteFromFields(rowToFields(names, row)));
  return { valuationDate, quotes };
}

export function vanillaSpecFromTrade(input: {
  tradeDate: string;
  optionType: "call" | "put";
  side: "long" | "short";
  strike?: number;
  strikeExpression?: string;
  expiryDate: string;
  notionalEur: number;
  label?: string;
}): { valuationDate: string; contract: FxOptionSpec } {
  return {
    valuationDate: input.tradeDate,
    contract: {
      instrumentTag: input.label?.trim() || `Booked_${input.optionType}`,
      fxCrossCode: "EURUSD",
      structure: "vanilla",
      callPut: input.optionType === "call" ? "Call" : "Put",
      buySell: input.side === "long" ? "Buy" : "Sell",
      ...(input.strikeExpression
        ? { strikeExpression: input.strikeExpression }
        : { strike: input.strike }),
      endDate: input.expiryDate,
      notionalAmount: input.notionalEur,
      notionalCcy: "EUR",
      exerciseStyle: "EURO",
    },
  };
}
