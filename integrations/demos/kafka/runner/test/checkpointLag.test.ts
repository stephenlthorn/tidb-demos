import { describe, expect, it } from 'vitest';
import { computeCheckpointLagMs, computeCheckpointLagMsFromTso, changefeedLagMs } from '../src/checkpointLag';

describe('computeCheckpointLagMs', () => {
  it('returns the gap between now and the checkpoint time', () => {
    const nowMs = Date.parse('2026-01-01T00:00:05.000Z');
    const checkpointTime = '2026-01-01 00:00:03.500';
    expect(computeCheckpointLagMs({ nowMs, checkpointTime })).toBe(1500);
  });

  it('floors negative results at zero for clock-skew safety', () => {
    const nowMs = Date.parse('2026-01-01T00:00:03.000Z');
    const checkpointTime = '2026-01-01 00:00:05.000';
    expect(computeCheckpointLagMs({ nowMs, checkpointTime })).toBe(0);
  });
});

describe('computeCheckpointLagMsFromTso', () => {
  const checkpointTso = '445644799344652345';

  it('computes lag from a raw checkpoint TSO using BigInt so large values keep full precision', () => {
    expect(computeCheckpointLagMsFromTso({ nowMs: 1700000000000, checkpointTso })).toBe(2500);
  });

  it('floors negative results at zero for clock-skew safety', () => {
    expect(computeCheckpointLagMsFromTso({ nowMs: 1699999997400, checkpointTso })).toBe(0);
  });
});

describe('changefeedLagMs', () => {
  it('measures lag from the checkpoint TSO against the wall clock, independent of time zones', () => {
    const checkpointTso = 469374811013120004n;
    const checkpointMs = Number(checkpointTso >> 18n);
    expect(changefeedLagMs({ checkpointTso, nowEpochMs: checkpointMs + 1500 })).toBe(1500);
  });

  it('never reports negative lag when the clock is behind the checkpoint', () => {
    expect(changefeedLagMs({ checkpointTso: 469374811013120004n, nowEpochMs: 0 })).toBe(0);
  });
});
