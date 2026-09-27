export type SchemaPropagationInput = {
  readonly controlPressedAtMs: number;
  readonly columnObservedAtMs: number | undefined;
  readonly nowMs: number;
};

export const computeSchemaPropagationMs = (input: SchemaPropagationInput): number | undefined =>
  input.columnObservedAtMs === undefined ? undefined : Math.max(0, input.columnObservedAtMs - input.controlPressedAtMs);
