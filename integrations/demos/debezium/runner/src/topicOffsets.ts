export type PartitionHighWatermark = {
  readonly high: string;
};

export const sumHighWatermarkOffsets = (partitions: readonly PartitionHighWatermark[]): number =>
  partitions.reduce((total, partition) => total + Number(BigInt(partition.high)), 0);
