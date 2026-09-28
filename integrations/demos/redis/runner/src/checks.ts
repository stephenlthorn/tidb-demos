import type { CheckStatus } from '@lab/contract';
import type { InvalidationMode } from './mode';

export type CheckOutcome = {
  readonly status: CheckStatus;
  readonly observed: string;
};

export type CdcZeroStaleInput = {
  readonly mode: InvalidationMode;
  readonly msSinceLastBurst: number | undefined;
  readonly invalidationLagP99Ms: number | undefined;
  readonly staleCount: number;
  readonly sampleCount: number;
};

export const evaluateCdcZeroStale = (input: CdcZeroStaleInput): CheckOutcome => {
  if (input.mode !== 'cdc') {
    return { status: 'pending', observed: 'ttl mode active' };
  }
  if (input.msSinceLastBurst === undefined) {
    return { status: 'pending', observed: 'no write-burst fired yet' };
  }
  if (input.invalidationLagP99Ms === undefined) {
    return { status: 'pending', observed: 'no invalidation lag samples yet' };
  }
  if (input.msSinceLastBurst < input.invalidationLagP99Ms) {
    return {
      status: 'pending',
      observed: `${input.msSinceLastBurst}ms since burst, waiting for ${input.invalidationLagP99Ms}ms lag window`,
    };
  }
  if (input.sampleCount === 0) {
    return { status: 'pending', observed: 'no samples in this tick' };
  }
  const status: CheckStatus = input.staleCount === 0 ? 'pass' : 'fail';
  return { status, observed: `stale=${input.staleCount}/${input.sampleCount}` };
};

export type VersionsConvergeInput = {
  readonly mode: InvalidationMode;
  readonly msSinceLastBurst: number | undefined;
  readonly invalidationLagP99Ms: number | undefined;
  readonly ttlMs: number;
  readonly mismatchedRowIds: readonly number[];
  readonly sampledRowCount: number;
};

export const evaluateVersionsConverge = (input: VersionsConvergeInput): CheckOutcome => {
  if (input.msSinceLastBurst === undefined) {
    return { status: 'pending', observed: 'no write-burst fired yet' };
  }
  const windowMs = input.mode === 'cdc' ? input.invalidationLagP99Ms : input.ttlMs;
  if (windowMs === undefined) {
    return { status: 'pending', observed: 'no invalidation lag samples yet' };
  }
  if (input.msSinceLastBurst < windowMs) {
    return {
      status: 'pending',
      observed: `${input.msSinceLastBurst}ms since burst, waiting for ${windowMs}ms convergence window`,
    };
  }
  if (input.sampledRowCount === 0) {
    return { status: 'pending', observed: 'no burst rows sampled yet' };
  }
  const status: CheckStatus = input.mismatchedRowIds.length === 0 ? 'pass' : 'fail';
  const mismatchDetail = input.mismatchedRowIds.length === 0 ? 'none' : input.mismatchedRowIds.join(',');
  return { status, observed: `sampled=${input.sampledRowCount} mismatches=${mismatchDetail}` };
};

export type CheckLatchState = {
  readonly status: CheckStatus;
  readonly settled: boolean;
};

export const initialCheckLatchState = (): CheckLatchState => ({ status: 'pending', settled: false });

export type NextCheckStateInput = {
  readonly current: CheckLatchState;
  readonly outcome: CheckStatus;
};

export type NextCheckStateResult = {
  readonly state: CheckLatchState;
  readonly emit: boolean;
};

export const nextCheckState = ({ current, outcome }: NextCheckStateInput): NextCheckStateResult => {
  if (current.settled) {
    return { state: current, emit: false };
  }
  if (outcome === current.status) {
    return { state: current, emit: false };
  }
  const settled = outcome === 'pass' || outcome === 'fail';
  return { state: { status: outcome, settled }, emit: true };
};
