export type FreshnessInput = {
  readonly committedAtMs: number;
  readonly visibleAtMs: number;
};

export const freshnessMs = (input: FreshnessInput): number => {
  if (input.visibleAtMs < input.committedAtMs) return 0;
  return input.visibleAtMs - input.committedAtMs;
};

export type DegradationInput = {
  readonly baselineP99Ms: number;
  readonly currentP99Ms: number;
};

export const degradationPct = (input: DegradationInput): number => {
  if (input.baselineP99Ms <= 0) return 0;
  return ((input.currentP99Ms - input.baselineP99Ms) / input.baselineP99Ms) * 100;
};
