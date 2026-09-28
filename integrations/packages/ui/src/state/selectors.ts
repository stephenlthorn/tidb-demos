import type { DemoState } from './demo-state';

export const latestValue = (state: DemoState, metricId: string): number | undefined =>
  state.metrics[metricId]?.at(-1)?.value;

const DENSE_SAMPLE_MS = 500;

export const edgeRate =(state: DemoState, edgeId: string, staleMs = 2500): number => {
  const samples = state.flows[edgeId] ?? [];
  const last = samples.at(-1);
  if (last === undefined || state.t - last.t > staleMs) return 0;
  const previous = samples.at(-2);
  const intervalMs = previous === undefined ? 1000 : last.t - previous.t;
  if (intervalMs >= DENSE_SAMPLE_MS) return last.count / (intervalMs / 1000);
  return samples.filter((sample) => sample.t > last.t - 1000).reduce((sum, sample) => sum + sample.count, 0);
};
