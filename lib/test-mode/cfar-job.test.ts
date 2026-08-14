import { describe, expect, it } from 'vitest';
import { CFAR_JOB_LIMITS, parseCfarJobsRequest } from '@/lib/test-mode/cfar-job';

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    stockM: 1,
    monthlyInflows: [1.2, 1.2, 1.2],
    monthlyOutflows: [0.4, 0.4, 0.4],
    tenureMonths: 3,
    spotUsd: 1.08,
    sigmaFxMonthly: 0.025,
    confidencePct: 95,
    forecastUncertainty1m: 0.08,
    hedgeSettleSchedule: [{ settleMonths: 2, notionalLocalM: 1 }],
    usdRatePctPa: 4.3,
    fcyRatePctPa: 2.15,
    rateVolPctPa: 0.45,
    ...overrides,
  };
}
const body = (input: unknown, id = 'a') => ({ jobs: [{ id, input }] });

function expectError(result: ReturnType<typeof parseCfarJobsRequest>): string {
  if (!('error' in result)) throw new Error('expected a rejection, got jobs');
  return result.error;
}

describe('parseCfarJobsRequest', () => {
  it('accepts a well-formed job and keeps its values', () => {
    const result = parseCfarJobsRequest(body(validInput()));
    if ('error' in result) throw new Error(result.error);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.id).toBe('a');
    expect(result.jobs[0]!.input.stockM).toBe(1);
    expect(result.jobs[0]!.input.hedgeSettleSchedule).toEqual([
      { settleMonths: 2, notionalLocalM: 1 },
    ]);
  });

  it('carries optional fields through only when present', () => {
    const bare = parseCfarJobsRequest(body(validInput()));
    if ('error' in bare) throw new Error(bare.error);
    // Absent stays absent so the engine's own defaults apply, rather than
    // being pinned to whatever the boundary would have guessed.
    expect(bare.jobs[0]!.input.seed).toBeUndefined();
    expect(bare.jobs[0]!.input.flowJitterDays).toBeUndefined();
    expect(bare.jobs[0]!.input.hedgeCarryScheduleUsdM).toBeUndefined();

    const full = parseCfarJobsRequest(
      body(validInput({ seed: 7, flowJitterDays: 3, hedgeCarryScheduleUsdM: [0, 1] })),
    );
    if ('error' in full) throw new Error(full.error);
    expect(full.jobs[0]!.input.seed).toBe(7);
    expect(full.jobs[0]!.input.flowJitterDays).toBe(3);
    expect(full.jobs[0]!.input.hedgeCarryScheduleUsdM).toEqual([0, 1]);
  });

  it('rejects malformed envelopes', () => {
    expect(expectError(parseCfarJobsRequest(null))).toMatch(/JSON object/);
    expect(expectError(parseCfarJobsRequest('nope'))).toMatch(/JSON object/);
    expect(expectError(parseCfarJobsRequest({}))).toMatch(/non-empty array/);
    expect(expectError(parseCfarJobsRequest({ jobs: [] }))).toMatch(/non-empty array/);
    expect(expectError(parseCfarJobsRequest({ jobs: ['x'] }))).toMatch(/must be an object/);
  });

  it('requires a usable id and refuses duplicates', () => {
    expect(expectError(parseCfarJobsRequest(body(validInput(), '')))).toMatch(/id/);
    expect(
      expectError(parseCfarJobsRequest({ jobs: [{ id: 'x'.repeat(201), input: validInput() }] })),
    ).toMatch(/200 chars/);
    // Duplicates would let one job's result silently overwrite another's in
    // the client cache, which is worse than refusing the request.
    expect(
      expectError(
        parseCfarJobsRequest({
          jobs: [
            { id: 'dup', input: validInput() },
            { id: 'dup', input: validInput() },
          ],
        }),
      ),
    ).toMatch(/Duplicate job id/);
  });

  it('rejects non-finite numbers wherever they appear', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined]) {
      expect(expectError(parseCfarJobsRequest(body(validInput({ spotUsd: bad }))))).toMatch(
        /spotUsd/,
      );
    }
    expect(
      expectError(parseCfarJobsRequest(body(validInput({ monthlyInflows: [1, 'x'] })))),
    ).toMatch(/finite numbers/);
    expect(
      expectError(parseCfarJobsRequest(body(validInput({ seed: Number.NaN })))),
    ).toMatch(/seed/);
  });

  // The point of the boundary: the browser picks these numbers, so nothing may
  // be taken on trust that could turn one request into minutes of CPU.
  it('caps the work a single request can ask for', () => {
    const many = {
      jobs: Array.from({ length: CFAR_JOB_LIMITS.maxJobs + 1 }, (_, i) => ({
        id: `j${i}`,
        input: validInput(),
      })),
    };
    expect(expectError(parseCfarJobsRequest(many))).toMatch(/exceeds the limit/);

    expect(
      expectError(parseCfarJobsRequest(body(validInput({ tenureMonths: 100_000 })))),
    ).toMatch(/tenureMonths exceeds/);
    expect(
      expectError(parseCfarJobsRequest(body(validInput({ tenureMonths: 0 })))),
    ).toMatch(/positive/);

    expect(
      expectError(
        parseCfarJobsRequest(
          body(validInput({ monthlyInflows: new Array(5000).fill(1) })),
        ),
      ),
    ).toMatch(/exceeds \d+ entries/);

    expect(
      expectError(
        parseCfarJobsRequest(
          body(
            validInput({
              hedgeSettleSchedule: new Array(1000).fill({
                settleMonths: 1,
                notionalLocalM: 1,
              }),
            }),
          ),
        ),
      ),
    ).toMatch(/legs/);

    // paths is clamped rather than refused — an over-large ask is harmless
    // once bounded, and the engine clamps again internally.
    const clamped = parseCfarJobsRequest(body(validInput({ paths: 10_000_000 })));
    if ('error' in clamped) throw new Error(clamped.error);
    expect(clamped.jobs[0]!.input.paths).toBe(CFAR_JOB_LIMITS.maxPaths);
  });

  it('validates hedge legs individually', () => {
    expect(
      expectError(parseCfarJobsRequest(body(validInput({ hedgeSettleSchedule: [null] })))),
    ).toMatch(/must be objects/);
    expect(
      expectError(
        parseCfarJobsRequest(body(validInput({ hedgeSettleSchedule: [{ settleMonths: 1 }] }))),
      ),
    ).toMatch(/finite settleMonths and notionalLocalM/);
    expect(
      expectError(
        parseCfarJobsRequest(
          body(
            validInput({
              hedgeSettleSchedule: [
                { settleMonths: 1, notionalLocalM: 1, strikeUsd: 'x' },
              ],
            }),
          ),
        ),
      ),
    ).toMatch(/strikeUsd/);
  });

  it('drops unknown fields instead of forwarding them to the engine', () => {
    const result = parseCfarJobsRequest(
      body(validInput({ __proto__: { polluted: true }, sneaky: 'value' })),
    );
    if ('error' in result) throw new Error(result.error);
    const passed = result.jobs[0]!.input as unknown as Record<string, unknown>;
    expect('sneaky' in passed).toBe(false);
    expect(passed.polluted).toBeUndefined();
  });
});
