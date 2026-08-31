const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  return Number.isFinite(new Date(value + "T12:00:00Z").getTime());
}

/** Parse API / form strings to YYYY-MM-DD (UTC noon-safe). */
export function parseToIsoDate(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  if (ISO_DATE_RE.test(trimmed) && isIsoDate(trimmed)) return trimmed;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addCalendarDays(iso: string, days: number): string {
  const parsed = parseToIsoDate(iso);
  if (!parsed) throw new Error(`Invalid date: ${iso}`);
  const d = new Date(parsed + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date after offset: ${iso}`);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenIso(a: string, b: string): number {
  const da = parseToIsoDate(a);
  const db = parseToIsoDate(b);
  if (!da || !db) return NaN;
  const t1 = new Date(da + "T12:00:00Z").getTime();
  const t2 = new Date(db + "T12:00:00Z").getTime();
  return Math.round((t2 - t1) / 86_400_000);
}
