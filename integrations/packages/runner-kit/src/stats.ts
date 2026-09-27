export type LatencySummary = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
};

export type SampleWindow = {
  readonly add: (value: number) => void;
  readonly drain: () => readonly number[];
};

const ascending = (values: readonly number[]): readonly number[] => [...values].sort((a, b) => a - b);

const nearestRank = (sorted: readonly number[], p: number): number | undefined => {
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
};

export const percentile = (values: readonly number[], p: number): number | undefined => {
  if (values.length === 0) return undefined;
  return nearestRank(ascending(values), p);
};

export const summarize = (values: readonly number[]): LatencySummary | undefined => {
  const sorted = ascending(values);
  const p50 = nearestRank(sorted, 50);
  const p95 = nearestRank(sorted, 95);
  const p99 = nearestRank(sorted, 99);
  const max = sorted[sorted.length - 1];
  if (p50 === undefined || p95 === undefined || p99 === undefined || max === undefined) return undefined;
  return { count: sorted.length, p50, p95, p99, max };
};

export const createSampleWindow = (): SampleWindow => {
  const values: number[] = [];
  return {
    add: (value) => {
      values.push(value);
    },
    drain: () => values.splice(0, values.length),
  };
};
