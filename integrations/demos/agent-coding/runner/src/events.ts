import type { AttemptScript } from './scripts';
import type { StepOutcome } from './harness';

export type RunEvent = {
  readonly run_id: string;
  readonly attempt_id: string;
  readonly step: number;
  readonly kind: string;
  readonly status: string;
  readonly model: string;
  readonly cost_usd: number;
  readonly merged: boolean;
  readonly message: string;
  readonly emitted_at: string;
  readonly source: string;
};

export const toLakeTimestamp = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

const roundUsd = (value: number): number => Math.round(value * 10000) / 10000;

export const stepEvent = (options: {
  readonly runId: string;
  readonly script: AttemptScript;
  readonly outcome: StepOutcome;
  readonly nowMs: number;
}): RunEvent => {
  const failed = options.outcome.halted;
  return {
    run_id: options.runId,
    attempt_id: options.script.attemptId,
    step: options.outcome.step,
    kind: 'step',
    status: failed ? 'failed' : 'ok',
    model: options.script.model,
    cost_usd: roundUsd(options.script.stepCostUsd),
    merged: false,
    message: failed ? `${options.outcome.test?.signature ?? 'failure'}: ${options.outcome.note}` : options.outcome.note,
    emitted_at: toLakeTimestamp(options.nowMs),
    source: 'live',
  };
};

export const attemptFinishedEvent = (options: {
  readonly runId: string;
  readonly script: AttemptScript;
  readonly outcomes: readonly StepOutcome[];
  readonly merged: boolean;
  readonly nowMs: number;
}): RunEvent => {
  const last = options.outcomes.at(-1);
  const failed = last?.halted === true;
  return {
    run_id: options.runId,
    attempt_id: options.script.attemptId,
    step: options.outcomes.length,
    kind: 'attempt.finished',
    status: failed ? 'failed' : 'passed',
    model: options.script.model,
    cost_usd: roundUsd(options.script.stepCostUsd * options.outcomes.length),
    merged: options.merged,
    message: failed ? `${last?.test?.signature ?? 'failure'} at step ${last?.step ?? 0}` : 'tests passed',
    emitted_at: toLakeTimestamp(options.nowMs),
    source: 'live',
  };
};

export const markerEvent = (options: { readonly runId: string; readonly markerId: string; readonly nowMs: number }): RunEvent => ({
  run_id: options.runId,
  attempt_id: 'none',
  step: 0,
  kind: 'marker',
  status: 'ok',
  model: 'none',
  cost_usd: 0,
  merged: false,
  message: options.markerId,
  emitted_at: toLakeTimestamp(options.nowMs),
  source: 'live',
});
