import { mulberry32 } from './random';
import { toLakeTimestamp, type RunEvent } from './events';
import { hashEmbedding } from './embedding';

const models: readonly string[] = ['fixture-model-a', 'fixture-model-b', 'fixture-model-c'];

const failureMessages: readonly string[] = [
  'ECONNRESET at step 7: connect ECONNRESET from payment gateway stub',
  'ECONNRESET at step 5: connect ECONNRESET while verifying retry wrapper',
  'AssertionError at step 6: expected one charge but ledger holds two',
  'AssertionError at step 4: charge id differs after a retried request',
  'TimeoutError at step 8: test run exceeded the step budget',
];

export const generateHistory = (options: {
  readonly seed: number;
  readonly runs: number;
  readonly endMs: number;
}): readonly RunEvent[] => {
  const next = mulberry32(options.seed);
  return Array.from({ length: options.runs }, (_, runIndex) =>
    Array.from({ length: 3 }, (_, attemptIndex): RunEvent => {
      const model = models[Math.floor(next() * models.length)] ?? 'fixture-model-a';
      const steps = 5 + Math.floor(next() * 6);
      const passed = next() < 0.55;
      const merged = passed && next() < 0.7;
      const message = passed
        ? 'tests passed'
        : (failureMessages[Math.floor(next() * failureMessages.length)] ?? 'unknown failure');
      return {
        run_id: `hist-${String(runIndex + 1).padStart(4, '0')}`,
        attempt_id: `attempt-${attemptIndex + 1}`,
        step: steps,
        kind: 'attempt.finished',
        status: passed ? 'passed' : 'failed',
        model,
        cost_usd: Math.round(steps * (0.02 + next() * 0.04) * 10000) / 10000,
        merged,
        message,
        emitted_at: toLakeTimestamp(options.endMs - (options.runs - runIndex) * 3600000),
        source: 'synthetic-history',
      };
    }),
  ).flat();
};

export type FailureRow = {
  readonly run_id: string;
  readonly attempt_id: string;
  readonly message: string;
  readonly vector: readonly number[];
};

export const failureRows = (events: readonly RunEvent[]): readonly FailureRow[] =>
  events
    .filter((event) => event.status === 'failed' && event.kind === 'attempt.finished')
    .map((event) => ({
      run_id: event.run_id,
      attempt_id: event.attempt_id,
      message: event.message,
      vector: hashEmbedding(event.message),
    }));
