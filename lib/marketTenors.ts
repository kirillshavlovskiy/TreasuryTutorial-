import { addCalendarDays, daysBetweenIso, isIsoDate } from "./isoDates";

/** FX tenor labels → calendar days (FXO Calculator / JPM conventions). */
export const FX_TENOR_DAYS: Record<string, number> = {
  ON: 1,
  TN: 2,
  SW: 7,
  "1D": 1,
  "1W": 7,
  "2W": 14,
  "3W": 21,
  "1M": 30,
  "2M": 60,
  "3M": 90,
  "4M": 120,
  "5M": 150,
  "6M": 180,
  "7M": 210,
  "8M": 240,
  "9M": 270,
  "10M": 300,
  "11M": 330,
  "1Y": 365,
  "15M": 450,
  "18M": 540,
  "21M": 630,
  "2Y": 730,
  "3Y": 1095,
  "4Y": 1460,
  "5Y": 1825,
  "6Y": 2190,
  "7Y": 2555,
  "10Y": 3650,
};

export function tenorToDays(label: string): number | undefined {
  const key = String(label ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s/g, "");
  return FX_TENOR_DAYS[key];
}

/** Common option tenors shown on the pricer and trade ticket. */
export const STANDARD_FX_TENORS = [
  "1W",
  "2W",
  "1M",
  "2M",
  "3M",
  "6M",
  "9M",
  "1Y",
  "2Y",
] as const;

export type StandardFxTenor = (typeof STANDARD_FX_TENORS)[number];

export const STANDARD_FX_TENOR_TITLES: Record<StandardFxTenor, string> = {
  "1W": "1 week",
  "2W": "2 weeks",
  "1M": "1 month",
  "2M": "2 months",
  "3M": "3 months",
  "6M": "6 months",
  "9M": "9 months",
  "1Y": "1 year",
  "2Y": "2 years",
};

export function dateFromTenor(startIso: string, tenor: string): string | null {
  if (!isIsoDate(startIso)) return null;
  const days = tenorToDays(tenor);
  if (days === undefined) return null;
  return addCalendarDays(startIso, days);
}

export function matchStandardTenor(
  startIso: string,
  endIso: string
): StandardFxTenor | null {
  if (!isIsoDate(startIso) || !isIsoDate(endIso)) return null;
  const days = daysBetweenIso(startIso, endIso);
  if (!Number.isFinite(days) || days <= 0) return null;
  for (const label of STANDARD_FX_TENORS) {
    if (tenorToDays(label) === days) return label;
  }
  return null;
}
