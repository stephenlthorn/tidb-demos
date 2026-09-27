import { tsoPhysicalMillis } from './canalJsonParser';

export type CheckpointLagInput = {
  readonly nowMs: number;
  readonly checkpointTime: string;
};

export const computeCheckpointLagMs = (input: CheckpointLagInput): number => {
  const checkpointMs = Date.parse(`${input.checkpointTime.replace(' ', 'T')}Z`);
  return Math.max(0, input.nowMs - checkpointMs);
};

export type CheckpointLagFromTsoInput = {
  readonly nowMs: number;
  readonly checkpointTso: string;
};

export const computeCheckpointLagMsFromTso = (input: CheckpointLagFromTsoInput): number => {
  const checkpointMs = tsoPhysicalMillis(BigInt(input.checkpointTso));
  const lagMs = BigInt(input.nowMs) - checkpointMs;
  return lagMs < 0n ? 0 : Number(lagMs);
};

export const changefeedLagMs = (input: { readonly checkpointTso: bigint; readonly nowEpochMs: number }): number => {
  const lagMs = BigInt(Math.round(input.nowEpochMs)) - tsoPhysicalMillis(input.checkpointTso);
  return lagMs < 0n ? 0 : Number(lagMs);
};
