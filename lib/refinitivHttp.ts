export class RefinitivHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "RefinitivHttpError";
  }
}

export function errorMessageFromRefinitivBody(text: string, status: number): string {
  try {
    const payload = JSON.parse(text) as unknown;
    if (typeof payload === "object" && payload !== null) {
      const rec = payload as Record<string, unknown>;
      if (
        typeof rec.error === "object" &&
        rec.error !== null &&
        "message" in rec.error &&
        typeof rec.error.message === "string"
      ) {
        return rec.error.message;
      }
      if (typeof rec.error === "string" && rec.error.trim()) return rec.error;
      if (typeof rec.message === "string" && rec.message.trim()) return rec.message;
    }
  } catch {
    /* use fallback */
  }
  return `Refinitiv Quantitative Analytics failed (${status})`;
}

export async function postRefinitivJson(
  url: string,
  accessToken: string,
  body: unknown
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RefinitivHttpError(errorMessageFromRefinitivBody(text, res.status), res.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Refinitiv returned non-JSON data");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
