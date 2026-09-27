import type { DemoState } from './demo-state';

export const latestValue = (state: DemoState, metricId: string): number | undefined =>
  state.metrics[metricId]?.at(-1)?.value;

export const edgeRate = (state: DemoState, edgeId: string, windowMs = 2000): number => {
  const total = (state.flows[edgeId] ?? [])
    .filter((sample) => sample.t > state.t - windowMs)
    .reduce((sum, sample) => sum + sample.count, 0);
  return total / (windowMs / 1000);
};
