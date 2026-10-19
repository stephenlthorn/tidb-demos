import { describe, expect, it } from 'vitest';
import { attemptFinishedEvent, markerEvent, stepEvent, toLakeTimestamp } from '../src/events';
import type { StepOutcome } from '../src/harness';
import type { AttemptScript } from '../src/scripts';

const script: AttemptScript = {
  attemptId: 'attempt-2',
  model: 'fixture-model-b',
  stepCostUsd: 0.03,
  steps: [{ step: 1, kind: 'read', note: 'Read' }],
};

const failing: StepOutcome = {
  step: 7,
  kind: 'verify',
  note: 'Run the suite',
  halted: true,
  test: { passed: false, failing: ['a'], passing: 0, signature: 'ECONNRESET' },
};

describe('toLakeTimestamp', () => {
  it('formats UTC with a space and milliseconds', () => {
    expect(toLakeTimestamp(Date.UTC(2026, 9, 17, 10, 0, 0, 250))).toBe('2026-10-17 10:00:00.250');
  });
});

describe('stepEvent', () => {
  it('marks a halted step as failed and carries the signature', () => {
    const event = stepEvent({ runId: 'run-1', script, outcome: failing, nowMs: 0 });
    expect(event).toMatchObject({
      run_id: 'run-1',
      attempt_id: 'attempt-2',
      step: 7,
      kind: 'step',
      status: 'failed',
      source: 'live',
      message: 'ECONNRESET: Run the suite',
    });
  });

  it('marks an ordinary step as ok', () => {
    const event = stepEvent({
      runId: 'run-1',
      script,
      outcome: { step: 1, kind: 'read', note: 'Read', halted: false },
      nowMs: 0,
    });
    expect(event.status).toBe('ok');
  });
});

describe('attemptFinishedEvent', () => {
  it('prices an attempt at its fixture step cost times the steps it ran', () => {
    const event = attemptFinishedEvent({
      runId: 'run-1',
      script,
      outcomes: [
        { step: 1, kind: 'read', note: 'Read', halted: false },
        { ...failing, step: 2 },
      ],
      merged: false,
      nowMs: 0,
    });
    expect(event).toMatchObject({ status: 'failed', cost_usd: 0.06, merged: false, message: 'ECONNRESET at step 2' });
  });

  it('reports a passing attempt and whether it merged', () => {
    const event = attemptFinishedEvent({
      runId: 'run-1',
      script,
      outcomes: [{ step: 1, kind: 'read', note: 'Read', halted: false }],
      merged: true,
      nowMs: 0,
    });
    expect(event).toMatchObject({ status: 'passed', merged: true, message: 'tests passed' });
  });
});

describe('markerEvent', () => {
  it('carries the marker id as its message', () => {
    expect(markerEvent({ runId: 'run-1', markerId: 'mk-1', nowMs: 0 })).toMatchObject({
      kind: 'marker',
      message: 'mk-1',
      source: 'live',
    });
  });
});
