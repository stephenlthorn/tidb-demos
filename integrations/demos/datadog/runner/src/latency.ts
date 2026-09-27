export type DetectionLatencyInput = {
  readonly injectedAtMs: number;
  readonly alertObservedAtMs: number | undefined;
};

export const detectionLatencySeconds = ({ injectedAtMs, alertObservedAtMs }: DetectionLatencyInput): number | undefined =>
  alertObservedAtMs === undefined ? undefined : (alertObservedAtMs - injectedAtMs) / 1000;
