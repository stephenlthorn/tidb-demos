export type DetectionLatencyInput = {
  readonly injectedAtMs: number;
  readonly receivedAtMs: number | undefined;
};

export const detectionLatencySeconds = ({ injectedAtMs, receivedAtMs }: DetectionLatencyInput): number | undefined =>
  receivedAtMs === undefined ? undefined : (receivedAtMs - injectedAtMs) / 1000;

export type RecoveryLatencyInput = {
  readonly clearedAtMs: number;
  readonly resolvedAtMs: number | undefined;
};

export const recoveryLatencySeconds = ({ clearedAtMs, resolvedAtMs }: RecoveryLatencyInput): number | undefined =>
  resolvedAtMs === undefined ? undefined : (resolvedAtMs - clearedAtMs) / 1000;
