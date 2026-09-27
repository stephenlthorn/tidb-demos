import { describe, expect, it } from 'vitest';
import { computeCheckpointLagMs, computeCheckpointLagMsFromTso } from '../src/checkpointLag';

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
