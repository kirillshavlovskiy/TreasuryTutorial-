import { describe, expect, it } from 'vitest';
import { progressFromSandbox } from '@/lib/db/progress-snapshot';
import { STORAGE_CATALOG, userProgressTableName } from '@/lib/db/storage-env';
import { markStep, seedSandbox } from '@/lib/test-mode/store';

describe('user progress table names', () => {
  it('partitions UAT vs production', () => {
    expect(userProgressTableName('snapshot', 'uat')).toBe('user_progress_uat');
    expect(userProgressTableName('step', 'production')).toBe(
      'user_progress_step_production',
    );
    expect(userProgressTableName('event', 'uat')).toBe('user_progress_event_uat');
  });

  it('catalog lists progress tables separately from the sandbox blob', () => {
    expect(STORAGE_CATALOG.user_progress.tables).toEqual([
      'user_progress_{env}',
      'user_progress_step_{env}',
      'user_progress_event_{env}',
    ]);
    expect(STORAGE_CATALOG.sandbox_blob.tables).toEqual(['sandbox_progress_{env}']);
  });
});

describe('progressFromSandbox', () => {
  it('starts not_started with 0/7 steps', () => {
    const snap = progressFromSandbox(seedSandbox('01'));
    expect(snap.status).toBe('not_started');
    expect(snap.stepsDone).toBe(0);
    expect(snap.stepsTotal).toBe(7);
    expect(snap.stepList.map(s => s.id)).toEqual([
      'buildWorkspace',
      'largestMismatch',
      'setVarConfidence',
      'readVar',
      'openCashCarry',
      'readCarryByCcy',
      'readCarryTotal',
    ]);
  });

  it('marks in_progress when a step is done', () => {
    const state = seedSandbox('01');
    state.progress = markStep(state.progress, 'buildWorkspace');
    const snap = progressFromSandbox(state);
    expect(snap.status).toBe('in_progress');
    expect(snap.stepsDone).toBe(1);
    expect(snap.steps.buildWorkspace).toBe('done');
  });

  it('marks in_progress when answers are started without steps', () => {
    const state = seedSandbox('01');
    state.answers.largestMismatchCcy = 'EUR';
    expect(progressFromSandbox(state).status).toBe('in_progress');
  });

  it('marks completed when Validate passed', () => {
    const state = seedSandbox('01');
    state.lastScore = { pass: true, checks: [], hints: [] };
    const snap = progressFromSandbox(state);
    expect(snap.status).toBe('completed');
    expect(snap.lastScorePass).toBe(true);
  });

  it('marks completed when every step is done', () => {
    const state = seedSandbox('practice');
    state.progress = markStep(state.progress, 'buildWorkspace');
    state.progress = markStep(state.progress, 'largestMismatch');
    state.progress = markStep(state.progress, 'setVarConfidence');
    state.progress = markStep(state.progress, 'readVar');
    state.progress = markStep(state.progress, 'openCashCarry');
    state.progress = markStep(state.progress, 'readCarryByCcy');
    state.progress = markStep(state.progress, 'readCarryTotal');
    const snap = progressFromSandbox(state);
    expect(snap.taskId).toBe('practice');
    expect(snap.status).toBe('completed');
    expect(snap.stepsDone).toBe(7);
  });
});
