export type FreshnessOptions = {
  readonly insertedAtMs: number;
  readonly visibleAtMs: number;
};

export const freshnessMs = (options: FreshnessOptions): number =>
  options.visibleAtMs - options.insertedAtMs;
