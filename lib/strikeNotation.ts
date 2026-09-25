import type { CallPut } from "./refinitivContracts";

export const STRIKE_SHORTCUTS = ["ATMF", "ATM", "10d", "25d", "35d"] as const;

export type ParsedStrike =
  | { kind: "absolute"; value: number }
  | { kind: "atm"; expression: "ATM" | "ATMF" | "ATMS" }
  | { kind: "delta"; deltaPct: number; optionType: "call" | "put" | null }
  | { kind: "moneyness"; expression: string };

function compactStrikeToken(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[Δ𝛅δ]/g, "D")
    .replace(/[_-\s]/g, "");
}

function deltaPctAmount(deltaPct: number): string {
  return Number.isInteger(deltaPct) ? String(deltaPct) : String(Number(deltaPct.toFixed(4)));
}

function deltaExpression(deltaPct: number, callPut: CallPut): string {
  return `${deltaPctAmount(deltaPct)}D${callPut === "Put" ? "P" : "C"}`;
}

export function parseStrikeInput(raw: string): ParsedStrike | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const plainNumber = trimmed.replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(plainNumber)) {
    const value = Number(plainNumber);
    if (!Number.isFinite(value) || value === 0) return null;
    if (value < 0) {
      const mag = Math.abs(value);
      if (Number.isInteger(mag) && mag >= 5 && mag < 50) {
        return { kind: "delta", deltaPct: mag, optionType: "put" };
      }
      return null;
    }
    if (Number.isInteger(value) && value >= 5 && value <= 50) {
      if (value === 50) return { kind: "atm", expression: "ATM" };
      return { kind: "delta", deltaPct: value, optionType: null };
    }
    return { kind: "absolute", value };
  }

  const token = compactStrikeToken(trimmed);
  if (!token) return null;

  if (token === "ATM") return { kind: "atm", expression: "ATM" };
  if (
    token === "ATMF" ||
    token === "ATMFWD" ||
    token === "ATMFORWARD" ||
    token === "FWD" ||
    token === "FORWARD"
  ) {
    return { kind: "atm", expression: "ATMF" };
  }
  if (token === "ATMS" || token === "ATMSPOT" || token === "SPOT") {
    return { kind: "atm", expression: "ATMS" };
  }
  if (
    token === "ATMD" ||
    token === "ATMDELTA" ||
    token === "ATMDNS" ||
    token === "DNS" ||
    token === "DN"
  ) {
    return { kind: "atm", expression: "ATM" };
  }

  const moneyness = token.match(/^(\d+(?:\.\d+)?)%(ITM|OTM|ITMS|OTMS|ITMF|OTMF)$/);
  if (moneyness) return { kind: "moneyness", expression: token };

  const ipaDelta = token.match(/^(\d+(?:\.\d+)?)D([CP])$/);
  if (ipaDelta) {
    const deltaPct = Number(ipaDelta[1]);
    if (!Number.isFinite(deltaPct) || deltaPct <= 0 || deltaPct > 50) return null;
    if (deltaPct >= 50) return { kind: "atm", expression: "ATM" };
    return {
      kind: "delta",
      deltaPct,
      optionType: ipaDelta[2] === "P" ? "put" : "call",
    };
  }

  const signed = token.match(/^([+-])(\d+(?:\.\d+)?)D?$/);
  if (signed) {
    const deltaPct = Number(signed[2]);
    if (!Number.isFinite(deltaPct) || deltaPct <= 0 || deltaPct > 50) return null;
    if (deltaPct >= 50) return { kind: "atm", expression: "ATM" };
    return {
      kind: "delta",
      deltaPct,
      optionType: signed[1] === "+" ? "call" : "put",
    };
  }

  const delta = token.match(/^(\d+(?:\.\d+)?)D?(P|PUT|C|CALL)?$/);
  if (delta) {
    const deltaPct = Number(delta[1]);
    if (!Number.isFinite(deltaPct) || deltaPct <= 0 || deltaPct > 50) return null;
    if (deltaPct >= 50) return { kind: "atm", expression: "ATM" };
    const suffix = delta[2];
    const optionType =
      suffix === "P" || suffix === "PUT"
        ? "put"
        : suffix === "C" || suffix === "CALL"
          ? "call"
          : null;
    return { kind: "delta", deltaPct, optionType };
  }

  return null;
}

export function strikeInputToContract(
  raw: string,
  callPut: CallPut
): { strike: number } | { strikeExpression: string } | null {
  const parsed = parseStrikeInput(raw);
  if (!parsed) return null;
  if (parsed.kind === "absolute") return { strike: parsed.value };
  if (parsed.kind === "atm") return { strikeExpression: parsed.expression };
  if (parsed.kind === "moneyness") return { strikeExpression: parsed.expression };
  const side: CallPut =
    parsed.optionType === "put"
      ? "Put"
      : parsed.optionType === "call"
        ? "Call"
        : callPut;
  return { strikeExpression: deltaExpression(parsed.deltaPct, side) };
}

export function strikeInputCallPut(raw: string): CallPut | null {
  const parsed = parseStrikeInput(raw);
  if (parsed?.kind !== "delta" || !parsed.optionType) return null;
  return parsed.optionType === "put" ? "Put" : "Call";
}

export function strikeShortcutActive(input: string, shortcut: string): boolean {
  const parsed = parseStrikeInput(input);
  const target = parseStrikeInput(shortcut);
  if (!parsed || !target) return false;
  if (parsed.kind === "atm" && target.kind === "atm") {
    return parsed.expression === target.expression;
  }
  if (parsed.kind === "delta" && target.kind === "delta") {
    return parsed.deltaPct === target.deltaPct && target.optionType === null;
  }
  return false;
}

export function strikeExpressionHint(raw: string, callPut: CallPut): string | null {
  const mapped = strikeInputToContract(raw, callPut);
  if (!mapped || !("strikeExpression" in mapped)) return null;
  return mapped.strikeExpression;
}

/** Map an IPA signed delta (−25 / 0 / 25, or −0.25) onto the desk strike field. */
export function strikeInputFromSignedDelta(signed: number): {
  strikeInput: string;
  optionPut?: boolean;
} {
  if (!Number.isFinite(signed)) return { strikeInput: "ATMF" };
  let mag = Math.abs(signed);
  if (mag < 1e-9 || mag >= 49.5) return { strikeInput: "ATMF" };
  if (mag <= 1) mag *= 100;
  mag = Math.round(mag);
  if (mag < 5 || mag >= 50) return { strikeInput: "ATMF" };
  const put = signed < 0;
  return { strikeInput: `${mag}D${put ? "P" : "C"}`, optionPut: put };
}
