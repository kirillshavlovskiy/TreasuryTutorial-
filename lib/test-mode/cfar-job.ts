import type { CfarBandsResult } from '@/lib/test-mode/cfar-drawdown';
import type {
  McCfarComponentPoint,
  McCfarDiagnostics,
  McCfarInput,
  McHedgeSettleLeg,
} from '@/lib/test-mode/cfar-montecarlo';

/** One simulation the client wants run. `id` is opaque to the server and is
 * echoed back on the result so the caller can match it to its own cache. */
export interface CfarJob {
  id: string;
  input: McCfarInput;
}

export type CfarBands = CfarBandsResult & McCfarDiagnostics;

/** Newline-delimited JSON pushed as each job finishes, so the client can
 * render currency by currency instead of waiting for the whole batch. */
export type CfarJobEvent =
  | { type: 'result'; id: string; bands: CfarBands }
  | { type: 'error'; id: string; message: string }
  | { type: 'done'; completed: number };

/**
 * Ceilings on a request the browser controls. The engine already clamps
 * `paths` internally, but nothing else stops a caller asking for a 400-month
 * horizon across 500 jobs, which is a single request that pins a server core
 * for minutes. Each limit sits far above what the UI can produce: the widest
 * real batch is the frontier's 10 jobs, and the longest horizon offered is 36
 * months.
 */
export const CFAR_JOB_LIMITS = {
  maxJobs: 32,
  maxTenureMonths: 120,
  maxSeriesLength: 121,
  maxHedgeLegs: 64,
  maxPaths: 4000,
} as const;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function numberSeries(v: unknown, field: string): readonly number[] | string {
  if (!Array.isArray(v)) return `${field} must be an array of numbers`;
  if (v.length > CFAR_JOB_LIMITS.maxSeriesLength) {
    return `${field} exceeds ${CFAR_JOB_LIMITS.maxSeriesLength} entries`;
  }
  for (const entry of v) {
    if (!isFiniteNumber(entry)) return `${field} must contain finite numbers`;
  }
  return v as readonly number[];
}

function hedgeSchedule(v: unknown): readonly McHedgeSettleLeg[] | string {
  if (!Array.isArray(v)) return 'hedgeSettleSchedule must be an array';
  if (v.length > CFAR_JOB_LIMITS.maxHedgeLegs) {
    return `hedgeSettleSchedule exceeds ${CFAR_JOB_LIMITS.maxHedgeLegs} legs`;
  }
  const legs: McHedgeSettleLeg[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) {
      return 'hedgeSettleSchedule entries must be objects';
    }
    const leg = raw as Record<string, unknown>;
    if (!isFiniteNumber(leg.settleMonths) || !isFiniteNumber(leg.notionalLocalM)) {
      return 'hedgeSettleSchedule legs need finite settleMonths and notionalLocalM';
    }
    if (leg.strikeUsd !== undefined && !isFiniteNumber(leg.strikeUsd)) {
      return 'hedgeSettleSchedule strikeUsd must be a finite number';
    }
    legs.push({
      settleMonths: leg.settleMonths,
      notionalLocalM: leg.notionalLocalM,
      ...(leg.strikeUsd === undefined ? {} : { strikeUsd: leg.strikeUsd }),
    });
  }
  return legs;
}

/**
 * Validate a decoded request body into jobs the engine can be handed safely.
 * Returns a plain message on rejection rather than throwing, so the route can
 * answer 400 with the reason instead of a stack trace.
 */
export function parseCfarJobsRequest(
  body: unknown,
): { jobs: CfarJob[] } | { error: string } {
  if (typeof body !== 'object' || body === null) {
    return { error: 'Body must be a JSON object' };
  }
  const rawJobs = (body as Record<string, unknown>).jobs;
  if (!Array.isArray(rawJobs) || rawJobs.length === 0) {
    return { error: 'jobs must be a non-empty array' };
  }
  if (rawJobs.length > CFAR_JOB_LIMITS.maxJobs) {
    return { error: `jobs exceeds the limit of ${CFAR_JOB_LIMITS.maxJobs}` };
  }

  const jobs: CfarJob[] = [];
  const seen = new Set<string>();
  for (const rawJob of rawJobs) {
    if (typeof rawJob !== 'object' || rawJob === null) {
      return { error: 'Each job must be an object' };
    }
    const { id, input: rawInput } = rawJob as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
      return { error: 'Each job needs a non-empty id of at most 200 chars' };
    }
    if (seen.has(id)) return { error: `Duplicate job id: ${id}` };
    seen.add(id);
    if (typeof rawInput !== 'object' || rawInput === null) {
      return { error: `Job ${id} is missing an input object` };
    }
    const src = rawInput as Record<string, unknown>;

    for (const field of [
      'stockM', 'spotUsd', 'sigmaFxMonthly', 'confidencePct',
      'forecastUncertainty1m', 'usdRatePctPa', 'fcyRatePctPa', 'rateVolPctPa',
    ] as const) {
      if (!isFiniteNumber(src[field])) {
        return { error: `Job ${id}: ${field} must be a finite number` };
      }
    }
    if (!isFiniteNumber(src.tenureMonths) || src.tenureMonths <= 0) {
      return { error: `Job ${id}: tenureMonths must be a positive number` };
    }
    if (src.tenureMonths > CFAR_JOB_LIMITS.maxTenureMonths) {
      return {
        error: `Job ${id}: tenureMonths exceeds ${CFAR_JOB_LIMITS.maxTenureMonths}`,
      };
    }

    const inflows = numberSeries(src.monthlyInflows, 'monthlyInflows');
    if (typeof inflows === 'string') return { error: `Job ${id}: ${inflows}` };
    const outflows = numberSeries(src.monthlyOutflows, 'monthlyOutflows');
    if (typeof outflows === 'string') return { error: `Job ${id}: ${outflows}` };
    const schedule = hedgeSchedule(src.hedgeSettleSchedule);
    if (typeof schedule === 'string') return { error: `Job ${id}: ${schedule}` };

    const input: McCfarInput = {
      stockM: src.stockM as number,
      monthlyInflows: inflows,
      monthlyOutflows: outflows,
      tenureMonths: src.tenureMonths,
      spotUsd: src.spotUsd as number,
      sigmaFxMonthly: src.sigmaFxMonthly as number,
      confidencePct: src.confidencePct as number,
      forecastUncertainty1m: src.forecastUncertainty1m as number,
      hedgeSettleSchedule: schedule,
      usdRatePctPa: src.usdRatePctPa as number,
      fcyRatePctPa: src.fcyRatePctPa as number,
      rateVolPctPa: src.rateVolPctPa as number,
    };

    for (const field of [
      'settlementJitterDays', 'flowJitterDays', 'borrowSpreadPctPa',
      'openingUsdCashM', 'seed',
    ] as const) {
      const value = src[field];
      if (value === undefined) continue;
      if (!isFiniteNumber(value)) {
        return { error: `Job ${id}: ${field} must be a finite number` };
      }
      input[field] = value;
    }
    if (src.paths !== undefined) {
      if (!isFiniteNumber(src.paths) || src.paths <= 0) {
        return { error: `Job ${id}: paths must be a positive number` };
      }
      input.paths = Math.min(src.paths, CFAR_JOB_LIMITS.maxPaths);
    }
    if (src.hedgeCarryScheduleUsdM !== undefined) {
      const carry = numberSeries(src.hedgeCarryScheduleUsdM, 'hedgeCarryScheduleUsdM');
      if (typeof carry === 'string') return { error: `Job ${id}: ${carry}` };
      input.hedgeCarryScheduleUsdM = carry;
    }

    jobs.push({ id, input });
  }
  return { jobs };
}

export type { McCfarComponentPoint, McCfarInput };
