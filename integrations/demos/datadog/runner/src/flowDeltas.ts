export type CounterDeltaInput = {
  readonly previous: number | undefined;
  readonly current: number;
};

export const computeCounterDelta = (input: CounterDeltaInput): number =>
  input.previous === undefined ? 0 : Math.max(0, input.current - input.previous);
