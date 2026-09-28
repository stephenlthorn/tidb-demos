export type PartitionHighWatermark = {
  readonly partition: number;
  readonly high: string;
};

export const sumHighWatermarks = (samples: readonly PartitionHighWatermark[]): number =>
  samples.reduce((total, sample) => total + Number(sample.high), 0);

export type OffsetDeltaInput = {
  readonly previousTotal: number | undefined;
  readonly currentTotal: number;
};

export const computeOffsetDelta = ({ previousTotal, currentTotal }: OffsetDeltaInput): number =>
  previousTotal === undefined ? 0 : Math.max(0, currentTotal - previousTotal);
