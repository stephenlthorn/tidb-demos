import { describe, expect, it } from 'vitest';
import {
  evaluateCdcZeroStale,
  evaluateVersionsConverge,
  initialCheckLatchState,
  nextCheckState,
  type CheckLatchState,
} from '../src/checks';

describe('evaluateCdcZeroStale', () => {
  it('is pending in ttl mode regardless of other inputs', () => {
    const result = evaluateCdcZeroStale({
      mode: 'ttl',
      msSinceLastBurst: 10_000,
      invalidationLagP99Ms: 50,
      staleCount: 3,
      sampleCount: 10,
    });
    expect(result).toEqual({ status: 'pending', observed: 'ttl mode active' });
  });

  it('is pending in cdc mode when no write-burst has fired yet', () => {
    const result = evaluateCdcZeroStale({
      mode: 'cdc',
      msSinceLastBurst: undefined,
      invalidationLagP99Ms: 50,
      staleCount: 0,
      sampleCount: 10,
    });
    expect(result).toEqual({ status: 'pending', observed: 'no write-burst fired yet' });
  });

  it('is pending in cdc mode when there are no invalidation lag samples yet', () => {
    const result = evaluateCdcZeroStale({
      mode: 'cdc',
      msSinceLastBurst: 10_000,
      invalidationLagP99Ms: undefined,
      staleCount: 0,
      sampleCount: 10,
    });
    expect(result).toEqual({ status: 'pending', observed: 'no invalidation lag samples yet' });
  });

  it('is pending while still inside the invalidation-lag-p99 window since the last burst', () => {
    const result = evaluateCdcZeroStale({
      mode: 'cdc',
      msSinceLastBurst: 40,
      invalidationLagP99Ms: 50,
      staleCount: 0,
      sampleCount: 10,
    });
    expect(result.status).toBe('pending');
  });

  it('is pending when the window has elapsed but the tick sampled no rows', () => {
    const result = evaluateCdcZeroStale({
      mode: 'cdc',
      msSinceLastBurst: 60,
      invalidationLagP99Ms: 50,
      staleCount: 0,
      sampleCount: 0,
    });
    expect(result).toEqual({ status: 'pending', observed: 'no samples in this tick' });
  });

  it('passes with the measured stale and sample counts when the window has elapsed and no reads were stale', () => {
    const result = evaluateCdcZeroStale({
      mode: 'cdc',
      msSinceLastBurst: 60,
      invalidationLagP99Ms: 50,
      staleCount: 0,
      sampleCount: 20,
    });
    expect(result).toEqual({ status: 'pass', observed: 'stale=0/20' });
  });

  it('fails with the measured stale and sample counts when the window has elapsed and reads are still stale', () => {
    const result = evaluateCdcZeroStale({
      mode: 'cdc',
      msSinceLastBurst: 60,
      invalidationLagP99Ms: 50,
      staleCount: 4,
      sampleCount: 20,
    });
    expect(result).toEqual({ status: 'fail', observed: 'stale=4/20' });
  });
});

describe('evaluateVersionsConverge', () => {
  it('is pending when no write-burst has fired yet', () => {
    const result = evaluateVersionsConverge({
      mode: 'cdc',
      msSinceLastBurst: undefined,
      invalidationLagP99Ms: 50,
      ttlMs: 5_000,
      mismatchedRowIds: [],
      sampledRowCount: 0,
    });
    expect(result).toEqual({ status: 'pending', observed: 'no write-burst fired yet' });
  });

  it('is pending in cdc mode when there are no invalidation lag samples yet', () => {
    const result = evaluateVersionsConverge({
      mode: 'cdc',
      msSinceLastBurst: 10_000,
      invalidationLagP99Ms: undefined,
      ttlMs: 5_000,
      mismatchedRowIds: [],
      sampledRowCount: 0,
    });
    expect(result).toEqual({ status: 'pending', observed: 'no invalidation lag samples yet' });
  });

  it('is pending in cdc mode while still inside the invalidation-lag-p99 window', () => {
    const result = evaluateVersionsConverge({
      mode: 'cdc',
      msSinceLastBurst: 40,
      invalidationLagP99Ms: 50,
      ttlMs: 5_000,
      mismatchedRowIds: [],
      sampledRowCount: 3,
    });
    expect(result.status).toBe('pending');
  });

  it('is pending in ttl mode while still inside the ttl window', () => {
    const result = evaluateVersionsConverge({
      mode: 'ttl',
      msSinceLastBurst: 1_000,
      invalidationLagP99Ms: undefined,
      ttlMs: 5_000,
      mismatchedRowIds: [],
      sampledRowCount: 3,
    });
    expect(result.status).toBe('pending');
  });

  it('is pending when the window has elapsed but no burst rows were sampled', () => {
    const result = evaluateVersionsConverge({
      mode: 'cdc',
      msSinceLastBurst: 60,
      invalidationLagP99Ms: 50,
      ttlMs: 5_000,
      mismatchedRowIds: [],
      sampledRowCount: 0,
    });
    expect(result).toEqual({ status: 'pending', observed: 'no burst rows sampled yet' });
  });

  it('passes with sampled and mismatch counts once the cdc window has elapsed and every row converged', () => {
    const result = evaluateVersionsConverge({
      mode: 'cdc',
      msSinceLastBurst: 60,
      invalidationLagP99Ms: 50,
      ttlMs: 5_000,
      mismatchedRowIds: [],
      sampledRowCount: 5,
    });
    expect(result).toEqual({ status: 'pass', observed: 'sampled=5 mismatches=none' });
  });

  it('fails and lists the mismatched row ids once the cdc window has elapsed', () => {
    const result = evaluateVersionsConverge({
      mode: 'cdc',
      msSinceLastBurst: 60,
      invalidationLagP99Ms: 50,
      ttlMs: 5_000,
      mismatchedRowIds: [3, 7],
      sampledRowCount: 5,
    });
    expect(result).toEqual({ status: 'fail', observed: 'sampled=5 mismatches=3,7' });
  });

  it('passes once the ttl window has elapsed in ttl mode', () => {
    const result = evaluateVersionsConverge({
      mode: 'ttl',
      msSinceLastBurst: 5_000,
      invalidationLagP99Ms: undefined,
      ttlMs: 5_000,
      mismatchedRowIds: [],
      sampledRowCount: 2,
    });
    expect(result).toEqual({ status: 'pass', observed: 'sampled=2 mismatches=none' });
  });
});

describe('initialCheckLatchState', () => {
  it('starts pending and unsettled', () => {
    expect(initialCheckLatchState()).toEqual({ status: 'pending', settled: false });
  });
});

describe('nextCheckState', () => {
  it('does not re-emit while the outcome stays pending', () => {
    const current = initialCheckLatchState();
    const result = nextCheckState({ current, outcome: 'pending' });
    expect(result).toEqual({ state: current, emit: false });
  });

  it('latches to pass and emits once', () => {
    const current = initialCheckLatchState();
    const result = nextCheckState({ current, outcome: 'pass' });
    expect(result).toEqual({ state: { status: 'pass', settled: true }, emit: true });
  });

  it('does not re-emit once already latched to pass', () => {
    const settledPass: CheckLatchState = { status: 'pass', settled: true };
    const result = nextCheckState({ current: settledPass, outcome: 'pass' });
    expect(result).toEqual({ state: settledPass, emit: false });
  });

  it('latches to fail and emits once', () => {
    const current = initialCheckLatchState();
    const result = nextCheckState({ current, outcome: 'fail' });
    expect(result).toEqual({ state: { status: 'fail', settled: true }, emit: true });
  });

  it('does not flip a latched fail back to pass on a later clean tick', () => {
    const settledFail: CheckLatchState = { status: 'fail', settled: true };
    const result = nextCheckState({ current: settledFail, outcome: 'pass' });
    expect(result).toEqual({ state: settledFail, emit: false });
  });

  it('a new write-burst resets the latch so it can settle again', () => {
    const reset = initialCheckLatchState();
    const stillPending = nextCheckState({ current: reset, outcome: 'pending' });
    expect(stillPending).toEqual({ state: reset, emit: false });
    const settled = nextCheckState({ current: reset, outcome: 'fail' });
    expect(settled).toEqual({ state: { status: 'fail', settled: true }, emit: true });
  });
});
