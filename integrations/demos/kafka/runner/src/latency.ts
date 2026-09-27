export type LatencyInput = {
  readonly produceTs: number;
  readonly consumeTs: number;
};

export const computeE2eLatencyMs = (input: LatencyInput): number =>
  Math.max(0, input.consumeTs - input.produceTs);
